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

      // Stats Cards
      {
        element: '.stat-grid',
        popover: {
          title: '📈 Quick Stats Overview',
          description: 'These cards show key metrics: total boards audited, overdue campaigns, campaigns due soon (within 7 days), and campaigns due in 2 weeks. Click any card to filter the table.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="overdue"]',
        popover: {
          title: '🚨 Overdue Campaigns',
          description: 'Campaigns past their deadline. Click this card to view only overdue items. The red indicator highlights urgency.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="soon"]',
        popover: {
          title: '⚠️ Due Soon (Within 7 Days)',
          description: 'Campaigns approaching their deadline in the next 7 days. Click to filter and focus on these time-sensitive items.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '[data-status="2w"]',
        popover: {
          title: '📅 Due in 2 Weeks',
          description: 'Campaigns with deadlines within the next 14 days. These give you more planning time but should still be monitored.',
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
          description: 'Filter campaigns by assigned Customer Success Managers or Project Managers. Click to open a multi-select dropdown with all unique assignees.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#filter-csm-status-input',
        popover: {
          title: '📋 CSM Status Filter',
          description: 'Filter by CSM-specific campaign status labels pulled from the master board. Helps identify campaigns in specific workflow stages.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#campaign-sort',
        popover: {
          title: '⬇️ Campaign Sorting',
          description: 'Sort campaigns by: Name (A-Z or Z-A), Most Overdue First, Most Tasks First, or Highest Priority First. Choose the view that suits your workflow.',
          side: 'bottom',
          align: 'start'
        }
      },

      // Action Buttons Row
      {
        element: 'button:has(.fa-search)',
        popover: {
          title: '🔎 Lookup Master',
          description: 'Search the master campaign board (ID: 2845615047) to find any campaign and see its assigned CS Managers. Useful for quick reference without filtering.',
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
          description: 'Completion Analytics: Track how early/late campaigns finish relative to deadlines. Helps identify patterns and improve planning accuracy over time.',
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
          description: 'Sort by Customer Success Manager (pulled from master board data). Great for manager-level overviews.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#sort-deadline',
        popover: {
          title: '📅 Sort by Deadline',
          description: 'Sort campaigns chronologically by deadline date. Combine with status filters to prioritize your week.',
          side: 'bottom',
          align: 'center'
        }
      },
      {
        element: '#sort-daysOverdue',
        popover: {
          title: '⏰ Sort by Days Overdue',
          description: 'Sort by how many days a campaign is overdue (positive) or how many days until deadline (negative). Higher numbers = more urgent.',
          side: 'bottom',
          align: 'center'
        }
      },

      // Table Row Features
      {
        element: '#results-table-body',
        popover: {
          title: '📝 Campaign Rows',
          description: 'Each row represents a campaign. Click the expand arrow (▼) on any row to reveal campaign updates, tech summaries, and threaded replies from Monday.com.',
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

      // Final Tips
      {
        popover: {
          title: '🎉 You\'re All Set!',
          description: `
            <strong>Pro Tips:</strong><br><br>
            • <strong>Keyboard Shortcuts:</strong> Use Tab/Shift+Tab to navigate, Enter to expand rows<br>
            • <strong>Bulk Updates:</strong> Select multiple campaigns and use the bulk action bar at the bottom<br>
            • <strong>AI Quick Prompts:</strong> Click the ⚡ bolt icon in the chat to use pre-built analysis queries<br>
            • <strong>Priority Scores:</strong> Campaigns are auto-scored based on overdue days, status keywords, and tech summary urgency<br>
            • <strong>Master Board Sync:</strong> CS Manager assignments are pulled from board 2845615047 automatically<br>
            • <strong>Timeliness View:</strong> Track completion delta (early/late) to improve future estimates<br><br>
            Need help? Click the "?" icon next to any feature or open the AI Analyst!
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
