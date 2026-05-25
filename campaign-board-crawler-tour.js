/**
 * Campaign Board Crawler - Comprehensive Driver.js Tour
 * Covers all major touchpoints and features of the tool
 */

import { driver } from "driver.js";
import "driver.js/dist/driver.css";

// Custom styling for the tour
const tourStyles = `
  .driver-popover {
    background: rgba(30, 41, 59, 0.98);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(56, 189, 248, 0.3);
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }

  .driver-popover-title {
    color: #38bdf8;
    font-weight: 700;
    font-size: 16px;
  }

  .driver-popover-description {
    color: #f8fafc;
    line-height: 1.6;
  }

  .driver-popover-footer button {
    background: #38bdf8;
    color: #0f172a;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-weight: 600;
    transition: all 0.2s;
  }

  .driver-popover-footer button:hover {
    background: #0ea5e9;
    transform: translateY(-1px);
  }

  .driver-popover-prev-btn {
    background: transparent !important;
    border: 1px solid rgba(255, 255, 255, 0.2) !important;
    color: #f8fafc !important;
  }

  .driver-popover-close-btn {
    color: #94a3b8;
  }

  .driver-popover-close-btn:hover {
    color: #f8fafc;
  }
`;

// Inject custom styles
const styleEl = document.createElement('style');
styleEl.textContent = tourStyles;
document.head.appendChild(styleEl);

/**
 * Main tour - Complete walkthrough of all features
 */
export function startMainTour() {
  const driverObj = driver({
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next →',
    prevBtnText: '← Previous',
    doneBtnText: 'Finish ✓',
    steps: [
      // Welcome
      {
        element: 'header',
        popover: {
          title: '👋 Welcome to Campaign Auditor',
          description: 'This powerful tool helps you audit and manage Monday.com campaigns, tracking deadlines, assignments, and priorities across your organization. Let\'s take a comprehensive tour!',
          side: 'bottom',
          align: 'center'
        }
      },

      // Key Terms Overview
      {
        popover: {
          title: '📚 Key Terms to Know',
          description: `Before we start, here are the main concepts you'll encounter:<br><br>

          <strong>Deadline Categories:</strong><br>
          • <span style="color:#ef4444">Overdue</span> = Deadline has passed<br>
          • <span style="color:#f59e0b">Soon</span> = Due in 1-7 days<br>
          • <span style="color:#38bdf8">2 Weeks</span> = Due in 8-14 days<br><br>

          <strong>Key Metrics:</strong><br>
          • <strong>Days Overdue:</strong> How many days past (or before) deadline<br>
          • <strong>Priority Score:</strong> Auto-calculated urgency ranking<br><br>

          <strong>Data Sources:</strong><br>
          • <strong>Master Board (2845615047):</strong> Central source for CS Manager assignments and tech summaries<br>
          • <strong>Selected Folders:</strong> Your campaign boards to audit<br><br>

          Don't worry - we'll explain each term in detail as we go!`,
          side: 'center',
          align: 'center'
        }
      },

      // Step 1: Authentication
      {
        element: '#step-auth',
        popover: {
          title: '🔑 Step 1: Connect Your Account',
          description: 'Start by entering your Monday.com API v2 token. This authenticates the tool and gives it access to your workspace.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#api-key',
        popover: {
          title: '🔐 API Token Input',
          description: 'Paste your Monday.com API v2 token here. It starts with "ey..." and can be found in your Monday.com developer settings.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '.help-trigger-link',
        popover: {
          title: '❓ Need Help Getting Your Token?',
          description: 'Click this link for a step-by-step visual guide on how to obtain your Monday.com API token from the developer center.',
          side: 'bottom',
          align: 'start'
        }
      },

      // Step 2: Folder Selection (shown after connection)
      {
        element: '#step-folders',
        popover: {
          title: '📁 Step 2: Select Folders to Audit',
          description: 'Choose which board folders you want to scan. The tool will analyze all campaigns within selected folders and identify upcoming or overdue deadlines.',
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '#folder-list',
        popover: {
          title: '📂 Folder Grid',
          description: 'Each folder shows the workspace it belongs to and the number of boards it contains. Click on folders to select/deselect them for auditing.',
          side: 'left',
          align: 'start'
        }
      },
      {
        element: '.btn-secondary:nth-of-type(1)',
        popover: {
          title: '✅ Quick Selection',
          description: 'Use "Select All" to quickly choose all folders, or "Deselect All" to start fresh. Common campaign folders are pre-selected by default.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#status-exclusions',
        popover: {
          title: '🚫 Status Exclusions',
          description: 'Configure which task statuses to exclude from the audit (e.g., "Done", "Archive"). This helps focus on active campaigns only.',
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '#crawl-btn',
        popover: {
          title: '🚀 Start the Audit',
          description: 'Once you\'ve selected folders and configured exclusions, click here to begin scanning campaigns. The audit runs concurrently across all boards for speed.',
          side: 'left',
          align: 'center'
        }
      },

      // Step 3: Results Overview
      {
        element: '#step-results',
        popover: {
          title: '📊 Step 3: Audit Results',
          description: 'After the audit completes, this area displays all campaigns with their deadlines, assignments, and priority scores. Let\'s explore the controls and views.',
          side: 'top',
          align: 'center'
        }
      },

      // Stats Cards with clear definitions
      {
        element: '.stat-grid',
        popover: {
          title: '📈 Quick Stats Overview',
          description: `These cards show key metrics for your campaigns:<br><br>
          <strong>How deadlines are categorized:</strong><br>
          • <span style="color:#ef4444">Overdue</span> = Deadline has passed (today or earlier)<br>
          • <span style="color:#f59e0b">Soon</span> = Due within the next 7 days<br>
          • <span style="color:#38bdf8">2 Weeks</span> = Due within 8-14 days<br><br>
          Click any card to filter the table to show only that category.`,
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="overdue"]',
        popover: {
          title: '🚨 Overdue Campaigns',
          description: `<strong>Definition:</strong> Campaigns where the deadline date is today or in the past.<br><br>
          The number shows how many campaigns have missed their deadline. The "Days Overdue" column tells you exactly how many days late each campaign is.<br><br>
          <strong>Example:</strong> A campaign with deadline "May 20" viewed on May 25 is 5 days overdue.<br><br>
          Click this card to view only overdue campaigns.`,
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="soon"]',
        popover: {
          title: '⚠️ Due Soon (Within 7 Days)',
          description: `<strong>Definition:</strong> Campaigns with deadlines in the next 1-7 days from today.<br><br>
          These are time-sensitive campaigns that need attention this week. Use this filter to plan your immediate priorities.<br><br>
          <strong>Example:</strong> If today is May 25, campaigns due between May 26-31 appear here.<br><br>
          Click to filter and focus on this week's deadlines.`,
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="2w"]',
        popover: {
          title: '📅 Due in 2 Weeks (8-14 Days)',
          description: `<strong>Definition:</strong> Campaigns with deadlines 8-14 days from today.<br><br>
          These campaigns are on the horizon and give you planning time, but should be monitored to avoid becoming "Soon" or "Overdue".<br><br>
          <strong>Example:</strong> If today is May 25, campaigns due between June 2-8 appear here.<br><br>
          Click to view campaigns in this timeframe.`,
          side: 'bottom',
          align: 'center'
        }
      },

      // Filters Row 1
      {
        element: '#filter-text',
        popover: {
          title: '🔍 Search Filter',
          description: 'Search across campaign names and board names. Start typing to instantly filter the visible campaigns. Case-insensitive and works with partial matches.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#filter-csm-input',
        popover: {
          title: '👥 CS/PM Filter',
          description: `<strong>Definition:</strong> CS/PM = Customer Success Manager / Project Manager<br><br>
          This shows the person(s) assigned to each campaign in Monday.com. Filter by one or more team members to see only their campaigns.<br><br>
          <strong>How it works:</strong> The tool reads the "Person" column from each board to identify assignees.<br><br>
          Click to open a multi-select dropdown with all unique assignees.`,
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#filter-csm-status-input',
        popover: {
          title: '📋 CSM Status Filter',
          description: `<strong>Definition:</strong> CSM Status = Campaign workflow status from the CS Manager's perspective<br><br>
          These labels are pulled from the master board (ID: 2845615047) and represent the current stage of each campaign (e.g., "In Progress", "Planning", "On Hold").<br><br>
          <strong>How it differs from Task Status:</strong><br>
          • CSM Status = Overall campaign stage<br>
          • Task Status = Individual task completion state<br><br>
          Use this to identify campaigns in specific workflow stages.`,
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#campaign-sort',
        popover: {
          title: '⬇️ Campaign Sorting',
          description: `Sort campaigns using different criteria:<br><br>
          • <strong>Name (A-Z / Z-A):</strong> Alphabetical by campaign name<br>
          • <strong>Most Overdue First:</strong> Sorts by days past deadline (highest to lowest)<br>
          • <strong>Most Tasks First:</strong> Sorts by number of items in each campaign<br>
          • <strong>Highest Priority First:</strong> Uses the auto-calculated priority score<br><br>
          <strong>Priority Score:</strong> Automatically calculated based on:<br>
          - Days overdue (more days = higher score)<br>
          - Status keywords ("stuck", "at risk", "blocked")<br>
          - Tech summary urgency markers ("urgent", "critical", "delayed")<br><br>
          Choose the view that suits your workflow.`,
          side: 'bottom',
          align: 'start'
        }
      },

      // Action Buttons Row
      {
        element: 'button:has(.fa-search)',
        popover: {
          title: '🔎 Lookup Master',
          description: `<strong>What is the Master Board?</strong><br>
          The master campaign board (ID: 2845615047) is the central source of truth that contains:<br>
          • CS Manager assignments for each campaign<br>
          • Campaign workflow status (CSM Status)<br>
          • Tech summaries and notes<br>
          • Timeline information<br><br>
          <strong>How it works:</strong><br>
          This lookup tool searches the master board by campaign name or code, showing you the assigned CS Managers without having to filter the main table.<br><br>
          Useful for quick reference and cross-checking assignments.`,
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: 'button:has(.fa-cog)',
        popover: {
          title: '⚙️ Settings Panel',
          description: 'Open the settings modal to adjust status exclusions on the fly. Changes immediately affect the filtered results without re-running the audit.',
          side: 'bottom',
          align: 'start'
        }
      },

      // User Identity & Focus
      {
        element: '#user-selector',
        popover: {
          title: '👤 Select Yourself',
          description: 'Choose your name from the Monday.com user list. This enables the "My Focus" feature and personalizes the experience.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#my-focus-btn',
        popover: {
          title: '🎯 My Focus Mode',
          description: 'Once you\'ve selected yourself, click here to view ONLY campaigns assigned to you, automatically sorted by priority score. Perfect for daily standup prep!',
          side: 'bottom',
          align: 'center'
        }
      },

      // View Modes
      {
        element: '.view-toggle-container',
        popover: {
          title: '👁️ View Modes',
          description: 'Switch between three powerful views: By Staff (manager dashboard), All Campaigns (auditor table), and Timeliness (completion analytics). Each offers unique insights.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '#view-manager',
        popover: {
          title: '👥 By Staff View',
          description: 'Manager Dashboard: See campaigns grouped by team member with visual cards showing overdue/soon/2-week counts. Click any staff card to drill down into their campaigns.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '#view-auditor',
        popover: {
          title: '📋 All Campaigns View',
          description: 'Auditor Table: The default comprehensive table view with sortable columns, bulk actions, and expandable rows showing campaign updates and replies.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '#view-timeliness',
        popover: {
          title: '📊 Timeliness Analytics',
          description: `<strong>What is Timeliness Analytics?</strong><br>
          This view tracks campaign completion accuracy by comparing when campaigns were marked "Done" versus their original deadline.<br><br>
          <strong>Completion Delta:</strong> The difference between completion date and deadline<br>
          • <span style="color:#10b981">Negative delta</span> (e.g., -3 days) = Finished 3 days EARLY ✓<br>
          • <span style="color:#ef4444">Positive delta</span> (e.g., +5 days) = Finished 5 days LATE ✗<br>
          • <span style="color:#94a3b8">Zero delta</span> (0) = Finished exactly on deadline<br><br>
          <strong>Calculation:</strong> Delta = Completion Date - Deadline Date<br><br>
          Use this to identify patterns, improve estimations, and track team accuracy over time.`,
          side: 'bottom',
          align: 'center'
        }
      },

      // Auditor Table Features
      {
        element: '#select-all-cb',
        popover: {
          title: '☑️ Bulk Selection',
          description: 'Select all visible campaigns with one click. Use this with bulk actions to update multiple campaign statuses simultaneously.',
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '#sort-name',
        popover: {
          title: '🔤 Sortable Columns',
          description: 'Click any column header to sort. Click again to reverse order. The arrow icon shows the current sort direction (↑ ascending, ↓ descending).',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#sort-person',
        popover: {
          title: '👤 Sort by Assignee',
          description: 'Sort campaigns by the person assigned. Useful for quickly seeing who has what on their plate.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#sort-csManager',
        popover: {
          title: '👔 Sort by CS Manager',
          description: `<strong>Definition:</strong> CS Manager = Customer Success Manager assigned to the campaign<br><br>
          This data is pulled from the master board (2845615047) and shows who is responsible for each campaign's success.<br><br>
          <strong>How it's populated:</strong><br>
          The tool matches campaign names between your selected boards and the master board to retrieve CS Manager assignments.<br><br>
          Great for manager-level overviews and workload distribution.`,
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#sort-deadline',
        popover: {
          title: '📅 Sort by Deadline',
          description: `<strong>Definition:</strong> The target completion date for the campaign<br><br>
          The deadline is pulled from either:<br>
          • The "Date" column in Monday.com, OR<br>
          • The "To" date from a Timeline column<br><br>
          Campaigns are sorted chronologically, with the earliest deadline first (ascending) or latest first (descending).<br><br>
          Combine with status filters to prioritize your week.`,
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '#sort-daysOverdue',
        popover: {
          title: '⏰ Sort by Days Overdue',
          description: `<strong>Definition:</strong> Number of days between the deadline and today<br><br>
          <strong>How to read this:</strong><br>
          • <span style="color:#ef4444">Positive numbers</span> (e.g., +5) = Campaign is 5 days OVERDUE<br>
          • <span style="color:#10b981">Negative numbers</span> (e.g., -3) = Campaign is due in 3 days<br>
          • <span style="color:#94a3b8">Zero (0)</span> = Campaign is due TODAY<br><br>
          <strong>Calculation:</strong> Days Overdue = Today's Date - Deadline Date<br><br>
          Higher positive numbers = more urgent. Sort descending to see the most overdue first.`,
          side: 'bottom',
          align: 'center'
        }
      },

      // Table Row Features
      {
        element: '#results-table-body',
        popover: {
          title: '📝 Campaign Rows',
          description: `Each row represents a campaign from your Monday.com boards.<br><br>
          <strong>Click the expand arrow (▼)</strong> to reveal:<br>
          • <strong>Campaign Updates:</strong> Discussion threads and status updates from Monday.com<br>
          • <strong>Tech Summary:</strong> Technical notes and implementation details from the master board<br>
          • <strong>Threaded Replies:</strong> All replies to each update, preserving the conversation context<br><br>
          <strong>Tech Summary:</strong> A special field in the master board where technical details, blockers, and implementation notes are documented. These summaries are analyzed for urgency keywords when calculating priority scores.`,
          side: 'top',
          align: 'center'
        }
      },

      // Chat/AI Panel
      {
        element: '.chat-toggle-btn',
        popover: {
          title: '🤖 AI Campaign Analyst',
          description: 'Open the AI-powered chat panel to ask questions about visible campaigns. The AI analyzes current filters and provides insights, summaries, and recommendations.',
          side: 'left',
          align: 'end'
        }
      },

      // Loading Toast
      {
        element: '#loading-toast',
        popover: {
          title: '⏳ Progress Indicator',
          description: 'This draggable toast shows real-time progress during audits and data fetches. It displays which board is being scanned and the overall completion percentage.',
          side: 'left',
          align: 'end'
        }
      },

      // Final Tips and Glossary
      {
        popover: {
          title: '🎉 You\'re All Set!',
          description: `
            <strong>Quick Reference - Key Terms:</strong><br><br>

            <strong style="color:#ef4444">Overdue:</strong> Deadline is today or in the past<br>
            <strong style="color:#f59e0b">Soon:</strong> Due within next 1-7 days<br>
            <strong style="color:#38bdf8">2 Weeks:</strong> Due within 8-14 days<br><br>

            <strong>Days Overdue:</strong> Today minus Deadline (positive = late, negative = future)<br>
            <strong>Priority Score:</strong> Auto-calculated urgency (overdue days + status keywords + tech summary markers)<br>
            <strong>CS Manager:</strong> Customer Success Manager from master board (2845615047)<br>
            <strong>CSM Status:</strong> Overall campaign workflow stage<br>
            <strong>Tech Summary:</strong> Technical notes field in master board<br>
            <strong>Completion Delta:</strong> Finish date minus deadline (negative = early, positive = late)<br>
            <strong>Master Board:</strong> Central board (2845615047) with CS assignments & summaries<br><br>

            <strong>Pro Tips:</strong><br>
            • <strong>Keyboard Shortcuts:</strong> Tab/Shift+Tab to navigate, Enter to expand<br>
            • <strong>Bulk Updates:</strong> Select multiple campaigns for batch status changes<br>
            • <strong>AI Quick Prompts:</strong> Click ⚡ in chat for pre-built queries<br>
            • <strong>My Focus:</strong> Select yourself, then click 🎯 to see only your campaigns<br><br>

            Need help? Click "?" next to any feature or ask the AI Analyst!
          `,
          side: 'center',
          align: 'center'
        }
      }
    ],
    onDestroyed: () => {
      console.log('Tour completed!');
    }
  });

  driverObj.drive();
}

/**
 * Quick Tour - Highlights only essential features (for returning users)
 */
export function startQuickTour() {
  const driverObj = driver({
    showProgress: true,
    steps: [
      {
        element: 'header',
        popover: {
          title: '⚡ Quick Tour',
          description: 'Let\'s quickly review the essential features to get you started.',
        }
      },
      {
        element: '#api-key',
        popover: {
          title: '1️⃣ Enter API Token',
          description: 'Paste your Monday.com API v2 token to connect.',
        }
      },
      {
        element: '#folder-list',
        popover: {
          title: '2️⃣ Select Folders',
          description: 'Choose which campaign folders to audit.',
        }
      },
      {
        element: '#crawl-btn',
        popover: {
          title: '3️⃣ Start Audit',
          description: 'Click to begin scanning your campaigns.',
        }
      },
      {
        element: '.view-toggle-container',
        popover: {
          title: '4️⃣ Switch Views',
          description: 'Toggle between Staff, Campaigns, and Timeliness views.',
        }
      },
      {
        element: '#my-focus-btn',
        popover: {
          title: '5️⃣ Use My Focus',
          description: 'Select yourself in the dropdown, then click here to see only your campaigns.',
        }
      },
      {
        element: '.chat-toggle-btn',
        popover: {
          title: '6️⃣ Ask the AI',
          description: 'Use the AI Analyst to query and analyze campaigns.',
        }
      }
    ]
  });

  driverObj.drive();
}

/**
 * Feature-Specific Tours
 */

// Tour: AI Chat Features
export function startChatTour() {
  const driverObj = driver({
    showProgress: true,
    steps: [
      {
        element: '.chat-toggle-btn',
        popover: {
          title: '🤖 AI Campaign Analyst',
          description: 'Click to open the AI-powered analysis panel.',
        }
      },
      {
        element: '#chat-messages',
        popover: {
          title: '💬 Chat History',
          description: 'Your conversation with the AI appears here. The AI can analyze visible campaigns, answer questions, and provide insights.',
        }
      },
      {
        element: '#quick-prompts-btn',
        popover: {
          title: '⚡ Quick Prompts',
          description: 'Click the bolt icon to reveal pre-built queries like "Which campaigns are overdue?" or "Who has the most campaigns?"',
        }
      },
      {
        element: '#chat-input',
        popover: {
          title: '⌨️ Ask Anything',
          description: 'Type your own questions here. The AI understands context from currently visible/filtered campaigns. Press Enter to send.',
        }
      },
      {
        element: '#chat-expand-btn',
        popover: {
          title: '🖥️ Fullscreen Mode',
          description: 'Expand the chat to full screen for longer conversations or detailed AI responses.',
        }
      }
    ]
  });

  driverObj.drive();
}

// Tour: Manager View Features
export function startManagerViewTour() {
  const driverObj = driver({
    showProgress: true,
    steps: [
      {
        element: '#view-manager',
        popover: {
          title: '👥 Manager Dashboard',
          description: 'Click to switch to the "By Staff" view.',
        }
      },
      {
        element: '#manager-grid-container',
        popover: {
          title: '📊 Staff Cards',
          description: 'Each card represents a team member with campaign counts: overdue (red), soon (yellow), 2-weeks (blue), and total. Click any card to filter campaigns for that person.',
        }
      }
    ]
  });

  driverObj.drive();
}

// Tour: Timeliness Analytics
export function startTimelinessTour() {
  const driverObj = driver({
    showProgress: true,
    steps: [
      {
        element: '#view-timeliness',
        popover: {
          title: '📊 Timeliness Analytics',
          description: 'Click to switch to the completion analysis view.',
        }
      },
      {
        element: '#timeliness-container',
        popover: {
          title: '📈 Completion Delta',
          description: 'This view shows campaigns that have been marked "Done" and compares their completion date to the deadline. Green = finished early, red = finished late. Helps track team accuracy over time.',
        }
      }
    ]
  });

  driverObj.drive();
}

// Tour: Filtering & Sorting
export function startFilteringTour() {
  const driverObj = driver({
    showProgress: true,
    steps: [
      {
        element: '.stat-grid',
        popover: {
          title: '🎯 Filter by Status',
          description: 'Click any stat card to filter campaigns by that deadline category.',
        }
      },
      {
        element: '#filter-text',
        popover: {
          title: '🔍 Text Search',
          description: 'Type to filter by campaign or board name.',
        }
      },
      {
        element: '#filter-csm-input',
        popover: {
          title: '👥 People Filter',
          description: 'Click to open multi-select dropdown. Choose one or more team members to filter their campaigns.',
        }
      },
      {
        element: '#filter-csm-status-input',
        popover: {
          title: '📋 Status Filter',
          description: 'Filter by CSM-specific status labels from the master board.',
        }
      },
      {
        element: '#campaign-sort',
        popover: {
          title: '⬇️ Sort Campaigns',
          description: 'Change sort order: alphabetical, most overdue, most tasks, or highest priority.',
        }
      }
    ]
  });

  driverObj.drive();
}

/**
 * Initialize tour system
 * Call this on page load to set up tour triggers
 */
export function initTourSystem() {
  // Add tour trigger button to header
  const header = document.querySelector('header .brand');
  if (header) {
    const tourBtn = document.createElement('button');
    tourBtn.className = 'btn btn-secondary';
    tourBtn.style.cssText = 'margin-left: auto; font-size: 12px; padding: 6px 12px;';
    tourBtn.innerHTML = '<i class="fas fa-question-circle"></i> Tour';
    tourBtn.onclick = () => {
      // Show tour menu
      const menu = document.createElement('div');
      menu.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(30, 41, 59, 0.98);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 12px;
        padding: 24px;
        z-index: 10000;
        min-width: 320px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      `;
      menu.innerHTML = `
        <h3 style="color: #38bdf8; margin-bottom: 16px; font-size: 18px;">Choose a Tour</h3>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <button id="tour-main" class="btn" style="width: 100%;">
            <i class="fas fa-route"></i> Complete Tour (Recommended)
          </button>
          <button id="tour-quick" class="btn btn-secondary" style="width: 100%;">
            <i class="fas fa-bolt"></i> Quick Tour (5 mins)
          </button>
          <button id="tour-chat" class="btn btn-secondary" style="width: 100%;">
            <i class="fas fa-robot"></i> AI Chat Features
          </button>
          <button id="tour-manager" class="btn btn-secondary" style="width: 100%;">
            <i class="fas fa-users-cog"></i> Manager View
          </button>
          <button id="tour-timeliness" class="btn btn-secondary" style="width: 100%;">
            <i class="fas fa-chart-line"></i> Timeliness Analytics
          </button>
          <button id="tour-filtering" class="btn btn-secondary" style="width: 100%;">
            <i class="fas fa-filter"></i> Filtering & Sorting
          </button>
          <button id="tour-close" class="btn btn-secondary" style="width: 100%; margin-top: 8px;">
            Cancel
          </button>
        </div>
      `;

      document.body.appendChild(menu);

      // Backdrop
      const backdrop = document.createElement('div');
      backdrop.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 9999;
      `;
      document.body.appendChild(backdrop);

      const closeMenu = () => {
        menu.remove();
        backdrop.remove();
      };

      backdrop.onclick = closeMenu;
      document.getElementById('tour-close').onclick = closeMenu;
      document.getElementById('tour-main').onclick = () => { closeMenu(); startMainTour(); };
      document.getElementById('tour-quick').onclick = () => { closeMenu(); startQuickTour(); };
      document.getElementById('tour-chat').onclick = () => { closeMenu(); startChatTour(); };
      document.getElementById('tour-manager').onclick = () => { closeMenu(); startManagerViewTour(); };
      document.getElementById('tour-timeliness').onclick = () => { closeMenu(); startTimelinessTour(); };
      document.getElementById('tour-filtering').onclick = () => { closeMenu(); startFilteringTour(); };
    };

    header.appendChild(tourBtn);
  }

  // Check if user has seen tour before
  if (!localStorage.getItem('campaign_auditor_tour_completed')) {
    // Auto-start tour for new users after a short delay
    setTimeout(() => {
      if (confirm('Welcome to Campaign Auditor! Would you like to take a tour of the features?')) {
        startMainTour();
        localStorage.setItem('campaign_auditor_tour_completed', 'true');
      }
    }, 1000);
  }
}

// Auto-initialize if this script is loaded directly
if (typeof window !== 'undefined') {
  window.CampaignAuditorTour = {
    startMainTour,
    startQuickTour,
    startChatTour,
    startManagerViewTour,
    startTimelinessTour,
    startFilteringTour,
    initTourSystem
  };

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTourSystem);
  } else {
    initTourSystem();
  }
}
