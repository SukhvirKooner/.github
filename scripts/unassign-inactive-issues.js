const fetch = require('node-fetch-native');

const formatUnassignments = (unassignments) => {
  if (unassignments.length === 0) return '';
  
  // Group unassignments by issue
  const groupedByIssue = unassignments.reduce((acc, curr) => {
    const key = `${curr.repo}#${curr.issueNumber}`;
    if (!acc[key]) {
      acc[key] = {
        repo: curr.repo,
        owner: curr.owner,
        issueNumber: curr.issueNumber,
        issueUrl: curr.issueUrl,
        users: []
      };
    }
    acc[key].users.push(curr.user);
    return acc;
  }, {});

  // Format the grouped unassignments
  return Object.values(groupedByIssue)
    .map(({ users, repo, issueNumber, issueUrl }) => 
      `${users.map(u => `@${u}`).join(', ')} from <${issueUrl}|${repo}#${issueNumber}>`
    )
    .join(', ');
};

async function getAllIssues(github, owner, repo) {
  const allIssues = [];
  let page = 1;
  const perPage = 100;
  
  while (true) {
    console.log(`Fetching page ${page} of issues...`);
    
    try {
      const response = await github.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        per_page: perPage,
        page: page,
        filter: 'all',
        pulls: false
      });
      
      const issues = response.data.filter(issue => !issue.pull_request);
      
      if (issues.length === 0) {
        break; // No more issues to fetch
      }
      
      allIssues.push(...issues);
      console.log(`Fetched ${issues.length} issues (excluding PRs) from page ${page}`);
      
      if (issues.length < perPage) {
        break; // Last page has fewer items than perPage
      }
      
      page++;
    } catch (error) {
      console.error(`Error fetching issues page ${page}:`, error);
      break;
    }
  }
  
  console.log(`Total issues fetched (excluding PRs): ${allIssues.length}`);
  return allIssues;
}

const checkLinkedPRs = async (issue, github, owner, repo) => {
  try {
    if (!issue || !issue.number) {
      console.error('Invalid issue object received:', issue);
      return false;
    }

    let linkedPRs = new Set();
    console.log(`\nChecking linked PRs for issue #${issue.number}`);

    // Method 1: Check timeline with enhanced connected event handling
    try {
      console.log(`Checking timeline events for issue #${issue.number}`);
      
      // First get all events (includes more details than timeline)
      const { data: events } = await github.rest.issues.listEvents({
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100
      });

      // Enhanced logging for all events
      console.log('All events:', JSON.stringify(events.map(event => ({
        event: event.event,
        created_at: event.created_at,
        id: event.id
      })), null, 2));

      for (const event of events) {
        console.log(`Processing event:`, {
          event: event.event,
          id: event.id,
          created_at: event.created_at
        });

        if (event.event === 'connected') {
          try {
            // Get the specific event details which contains the PR info
            const { data: eventDetails } = await github.rest.issues.getEvent({
              owner,
              repo,
              event_id: event.id,
              mediaType: {
                previews: ['mockingbird']
              }
            });

            console.log('Connected event details:', JSON.stringify(eventDetails, null, 2));

            if (eventDetails.source && eventDetails.source.issue) {
              const prNumber = eventDetails.source.issue.number;
              console.log(`Found connected PR #${prNumber}, checking if open`);

              try {
                const { data: pr } = await github.rest.pulls.get({
                  owner,
                  repo,
                  pull_number: prNumber
                });

                if (pr && pr.state === 'open') {
                  console.log(`Confirmed PR #${prNumber} is open`);
                  linkedPRs.add(prNumber);
                } else {
                  console.log(`PR #${prNumber} is not open, state: ${pr?.state}`);
                }
              } catch (prError) {
                console.log(`Error checking PR #${prNumber}:`, prError.message);
              }
            }
          } catch (eventError) {
            console.log(`Error fetching event details:`, eventError.message);
          }
        }
      }

      // Also check timeline for cross-references
      const { data: timelineEvents } = await github.rest.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
        mediaType: {
          previews: ['mockingbird']
        }
      });

      for (const event of timelineEvents) {
        if (event.event === 'cross-referenced' && event?.source?.type === 'pull_request') {
          const prNumber = event.source.issue.number;
          try {
            const { data: pr } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: prNumber
            });
            
            if (pr && pr.state === 'open') {
              console.log(`Found open cross-referenced PR #${prNumber}`);
              linkedPRs.add(prNumber);
            }
          } catch (e) {
            console.log(`Error checking cross-referenced PR #${prNumber}:`, e.message);
          }
        }
      }
    } catch (timelineError) {
      console.error(`Error fetching events for issue #${issue.number}:`, timelineError.message);
    }

    // Method 2: Search for PRs that mention this issue
    try {
      const searchQuery = `repo:${owner}/${repo} type:pr is:open ${issue.number} in:body,title`;
      console.log(`Searching for PRs with query: ${searchQuery}`);
      
      const searchResult = await github.rest.search.issuesAndPullRequests({
        q: searchQuery
      });

      if (searchResult?.data?.items) {
        const foundPRs = searchResult.data.items.filter(item => item?.pull_request);
        console.log(`Found ${foundPRs.length} PRs mentioning this issue through search`);
        
        for (const pr of foundPRs) {
          if (pr?.number) {
            try {
              const prDetails = await github.rest.pulls.get({
                owner,
                repo,
                pull_number: pr.number
              });
              if (prDetails?.data) {
                linkedPRs.push(prDetails.data);
              }
            } catch (e) {
              console.log(`Error fetching PR #${pr.number} details:`, e.message);
            }
          }
        }
      }
    } catch (searchError) {
      console.log('Search API error:', searchError.message);
    }

    // Method 3: Check issue body for PR references
    if (issue.body) {
      const prReferences = new Set();
      const patterns = [
        /#(\d+)/g,
        new RegExp(`https?://github\\.com/${owner}/${repo}/pull/(\\d+)`, 'g'),
        /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#(\d+)/gi
      ];

      for (const pattern of patterns) {
        const matches = [...issue.body.matchAll(pattern)];
        for (const match of matches) {
          if (match?.[1]) {
            const prNumber = parseInt(match[1], 10);
            if (!isNaN(prNumber)) {
              prReferences.add(prNumber);
            }
          }
        }
      }

      console.log(`Found ${prReferences.size} PR references in issue body`);

      for (const prNumber of prReferences) {
        try {
          const prDetails = await github.rest.pulls.get({
            owner,
            repo,
            pull_number: prNumber
          });
          if (prDetails?.data?.state === 'open') {
            linkedPRs.push(prDetails.data);
          }
        } catch (e) {
          console.log(`Error fetching PR #${prNumber}:`, e.message);
        }
      }
    }

    // Return the set of linked PR numbers (or false if none found)
    return linkedPRs.size > 0 ? linkedPRs : false;
  } catch (error) {
    console.error(`Error in checkLinkedPRs for issue #${issue.number}:`, error);
    return false;
  }
};





// Function to check user membership and ownership
const checkUserMembership = async (owner, repo, username, github) => {
  try {
    // Check if the user is an owner of the repository
    const repoDetails = await github.rest.repos.get({
      owner,
      repo
    });

    // Check if the repository owner matches the username
    if (repoDetails.data.owner.login === username) {
      console.log(`${username} is the repository owner`);
      return true;
    }

    // Check if the user is an organization member
    try {
      await github.rest.orgs.getMembershipForUser({
        org: owner,
        username: username
      });
      console.log(`${username} is an organization member`);
      return true;
    } catch (orgError) {
      console.log(`${username} is not an organization member`);
      return false;
    }
  } catch (error) {
    console.error(`Error checking user membership for ${username}:`, error);
    return false;
  }
};

module.exports = async ({ github, context, core }) => {
  try {
    const unassignments = [];
    const inactivityPeriodInMinutes = 1;

    const [owner, repo] = context.payload.repository.full_name.split('/');
    console.log(`Processing repository: ${owner}/${repo}`);
    
    try {
      // Test API access by getting repository details
      const { data: repository } = await github.rest.repos.get({
        owner,
        repo
      });
      console.log('Successfully authenticated with GitHub App and verified repository access');
      console.log(`Repository: ${repository.full_name}`);
    } catch (authError) {
      console.error('Authentication error details:', {
        message: authError.message,
        status: authError.status,
        documentation_url: authError.documentation_url
      });
      throw new Error(`Repository access failed. Please check your GitHub App permissions for repository access. Error: ${authError.message}`);
    }

    // Get all issues using pagination
    const issues = await getAllIssues(github, owner, repo);
    console.log(`Processing ${issues.length} open issues`);

    for (const issue of issues) {
      if (!issue || !issue.number) {
        console.error('Skipping invalid issue:', issue);
        continue;
      }

      console.log(`\nProcessing issue #${issue.number}`);
      console.log('Issue data:', {
        number: issue.number,
        title: issue.title,
        assignees: issue.assignees ? issue.assignees.length : 0,
        updated_at: issue.updated_at
      });

      const assignees = issue.assignees || [];
      if (assignees.length === 0) {
        console.log(`Issue #${issue.number} has no assignees, skipping`);
        continue;
      }

      // Check if issue is inactive
      const lastActivity = new Date(issue.updated_at);
      const now = new Date();
      
      if (now - lastActivity <= inactivityPeriodInMinutes * 60 * 1000) {
        console.log(`Issue #${issue.number} is still active, skipping`);
        continue;
      }

      console.log(`Checking for linked PRs for issue #${issue.number}`);
      const hasOpenPRs = await checkLinkedPRs(issue, github, owner, repo);
      
      if (hasOpenPRs) {
        console.log(`Issue #${issue.number} has open PRs, skipping unassignment`);
        continue;
      }

      console.log(`Processing inactive issue #${issue.number} with no open PRs`);

      const inactiveAssignees = [];
      const activeAssignees = [];

      for (const assignee of assignees) {
        if (!assignee || !assignee.login) {
          console.log('Skipping invalid assignee:', assignee);
          continue;
        }

        if (assignee.site_admin || await checkUserMembership(owner, repo, assignee.login, github)) {
          activeAssignees.push(assignee.login);
          console.log(`${assignee.login} is an active member, keeping assignment`);
        } else {
          inactiveAssignees.push(assignee.login);
          console.log(`${assignee.login} is inactive, will be unassigned`);
        }
      }

      if (inactiveAssignees.length === 0) {
        console.log(`No inactive assignees for issue #${issue.number}, skipping`);
        continue;
      }

      try {
        // Update issue assignees
        await github.rest.issues.update({
          owner,
          repo,
          issue_number: issue.number,
          assignees: activeAssignees,
        });
        console.log(`Successfully unassigned users from issue #${issue.number}`);

        // Add comment
        const mentionList = inactiveAssignees.map(login => `@${login}`).join(', ');
        await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: `Automatically unassigning ${mentionList} due to inactivity. ${mentionList}, If you're still interested in this issue or already have work in progress, please message us here, and we'll assign you again. Thank you!`,
        });
        console.log(`Added comment to issue #${issue.number}`);

        // Record unassignments
        inactiveAssignees.forEach(login => {
          unassignments.push({
            user: login,
            repo,
            owner,
            issueNumber: issue.number,
            issueUrl: `https://github.com/${owner}/${repo}/issues/${issue.number}`
          });
        });

      } catch (issueError) {
        console.error(`Error processing issue #${issue.number}:`, {
          message: issueError.message,
          status: issueError.status
        });
        if (issueError.status === 403) {
          throw new Error('Token lacks necessary permissions. Ensure it has "issues" and "write" access.');
        }
      }
    }

    const formattedUnassignments = formatUnassignments(unassignments);
    console.log('Unassignments completed:', unassignments.length);
    
    try {
      core.setOutput('unassignments', formattedUnassignments);
      return formattedUnassignments;
    } catch (error) {
      console.error('Error setting output:', error);
      core.setFailed(error.message);
    }

  } catch (error) {
    console.error('Action failed:', error);
    console.error('Full error details:', error);
    core.setFailed(error.message);
    return '';
  }
};