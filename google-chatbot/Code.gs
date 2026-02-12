/**
 * GLOBAL CONFIGURATION & CONSTANTS
 */
const SGT_OFFSET = 8 * 60 * 60 * 1000;
const SCOPE = "https://www.googleapis.com/auth/chat.bot";

/**
 * Main entry point for Chat messages and Slash Commands
 */
function onMessage(event) {
  try {
    if (event.message && event.message.slashCommand) {
      const commandId = event.message.slashCommand.commandId;
      switch (commandId) {
        case 1: return help_commands();
        case 2: return query_card();
        case 3: // /ask
          moFaqQuery(event.space.name, event.message.argumentText, event.user.displayName);
          googleDriveQuery(event.space.name, event.message.argumentText, event.user.displayName);
          spaceHistoryQuery(event.space.name, event.message.argumentText, event.user.displayName);
          return {
            actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
            text: "🔍 Searching FAQ, Drive, and Space History... results will post shortly."
          };
        case 4: return multiSpaceQuery();
        case 5: return addUser();
        case 6: return addIdea();
        case 7: return reminder_SetupCard(); // /remind
        case 8: return removeUser();
        case 9: return reminder_ListCard(event.space.name); // /listreminders
      }
    }
    return; // Ignore regular messages or unhandled commands
  } catch (err) {
    return {
      actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
      text: "❌ Error in command: " + err.message
    };
  }
}


/**
 * REMINDER SYSTEM - FRESH REWRITE
 */

function reminder_SetupCard() {
  const now = Date.now();
  // We 'offset' the default display to match SGT literally in the UTC-based picker
  const defaultSgtDisplayValue = now + SGT_OFFSET;

  return {
    actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
    cardsV2: [{
      cardId: "rem_setup",
      card: {
        header: {
          title: "Schedule a Reminder",
          subtitle: "Timezone: Singapore (GMT+8)",
          imageUrl: "https://static.vecteezy.com/system/resources/thumbnails/014/568/141/small_2x/light-bulb-icon-light-bulb-ideas-and-creativity-analytical-thinking-for-innovation-processing-png.png",
          imageType: "CIRCLE"
        },
        sections: [{
          widgets: [
            { dateTimePicker: { name: "time", label: "Date & Time (SGT):", type: "DATE_AND_TIME", valueMsEpoch: defaultSgtDisplayValue } },
            { textInput: { name: "msg", label: "Message", placeholderText: "What should I remind you about?" } },
            { selectionInput: { name: "repeat", label: "Repeat Interval", type: "DROPDOWN", items: [
              { text: "Once", value: "none", selected: true },
              { text: "Daily", value: "daily" },
              { text: "Weekly", value: "weekly" },
              { text: "Monthly", value: "monthly" }
            ]}},
            { buttonList: { buttons: [
              { text: "Set Reminder", type: "FILLED", onClick: { action: { function: "reminder_SubmitAction" } } },
              { text: "View Active", onClick: { action: { function: "reminder_ListAction" } } }
            ]}}
          ]
        }]
      }
    }]
  };
}

function reminder_SubmitAction(event) {
  const pickerMs = fetchFormValue(event, "time");
  const msg = fetchFormValue(event, "msg");
  const repeat = fetchFormValue(event, "repeat") || "none";

  if (!pickerMs || !msg) {
    return { actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" }, text: "⚠️ Please enter a time and a message." };
  }

  // Adjust 'fake' SGT picker time back to real UTC for the actual trigger
  const triggerUtcMs = parseInt(pickerMs) - SGT_OFFSET;
  const id = "r_" + Date.now();

  const reminder = {
    id: id,
    utcMs: triggerUtcMs,
    msg: msg,
    repeat: repeat,
    space: event.space.name
  };

  try {
    const trigger = ScriptApp.newTrigger("reminder_DeliveryService").timeBased().at(new Date(triggerUtcMs)).create();
    
    // Store data
    const storage = JSON.parse(PropertiesService.getScriptProperties().getProperty('Reminders') || '{}');
    const mapping = JSON.parse(PropertiesService.getScriptProperties().getProperty('TriggerMap') || '{}');
    
    storage[id] = reminder;
    mapping[trigger.getUniqueId()] = id;
    
    PropertiesService.getScriptProperties().setProperty('Reminders', JSON.stringify(storage));
    PropertiesService.getScriptProperties().setProperty('TriggerMap', JSON.stringify(mapping));

    const displayTime = new Date(triggerUtcMs).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return { 
      actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" }, 
      text: "✅ Reminder set for " + displayTime + " (SGT)"
    };
  } catch (e) {
    return { 
      actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" }, 
      text: "❌ Authorization Failed. Please open the Apps Script editor and click 'Run' on any function to authorize triggers."
    };
  }
}

function reminder_ListCard(spaceName) {
  const storage = JSON.parse(PropertiesService.getScriptProperties().getProperty('Reminders') || '{}');
  const ids = Object.keys(storage).filter(id => storage[id].space === spaceName);

  if (ids.length === 0) {
    return {
      actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
      cardsV2: [{ card: { header: { title: "Active Reminders", subtitle: "None in this space" } } }]
    };
  }

  const items = ids.map(id => {
    const r = storage[id];
    const timeStr = new Date(r.utcMs).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return {
      decoratedText: {
        topLabel: timeStr + (r.repeat !== 'none' ? ` (${r.repeat})` : ''),
        text: r.msg,
        wrapText: true,
        button: { text: "Delete", onClick: { action: { function: "reminder_DeleteAction", parameters: [{ key: "id", value: id }] } } }
      }
    };
  });

  return {
    actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
    cardsV2: [{ card: { header: { title: "Active Reminders" }, sections: [{ widgets: items }] } }]
  };
}

function reminder_DeleteAction(event) {
  const id = event.common.parameters.id;
  const storage = JSON.parse(PropertiesService.getScriptProperties().getProperty('Reminders') || '{}');
  const mapping = JSON.parse(PropertiesService.getScriptProperties().getProperty('TriggerMap') || '{}');

  if (storage[id]) {
    delete storage[id];
    PropertiesService.getScriptProperties().setProperty('Reminders', JSON.stringify(storage));
    
    // Attempt trigger cleanup
    try {
      const liveTriggers = ScriptApp.getProjectTriggers();
      for (const tId in mapping) {
        if (mapping[tId] === id) {
          const t = liveTriggers.find(x => x.getUniqueId() === tId);
          if (t) ScriptApp.deleteTrigger(t);
          delete mapping[tId];
        }
      }
      PropertiesService.getScriptProperties().setProperty('TriggerMap', JSON.stringify(mapping));
    } catch (e) {
      Logger.log("Trigger delete failed (usually permissions): " + e);
    }
  }
  return reminder_ListCard(event.space.name);
}

function reminder_DeliveryService(e) {
  const mapping = JSON.parse(PropertiesService.getScriptProperties().getProperty('TriggerMap') || '{}');
  const storage = JSON.parse(PropertiesService.getScriptProperties().getProperty('Reminders') || '{}');
  const rid = mapping[e.triggerUid];

  if (rid && storage[rid]) {
    const r = storage[rid];
    try {
      const service = getService_();
      const options = {
        method: "post",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + service.getAccessToken() },
        payload: JSON.stringify({ text: "🔔 *Reminder:* " + r.msg })
      };
      UrlFetchApp.fetch("https://chat.googleapis.com/v1/" + r.space + "/messages", options);

      if (r.repeat !== 'none') {
        reminder_HandoverReschedule(rid);
      } else {
        delete storage[rid];
        PropertiesService.getScriptProperties().setProperty('Reminders', JSON.stringify(storage));
      }
    } catch (err) {
      Logger.log("Delivery Failed: " + err);
    }
    delete mapping[e.triggerUid];
    PropertiesService.getScriptProperties().setProperty('TriggerMap', JSON.stringify(mapping));
  }
}

function reminder_HandoverReschedule(id) {
  const storage = JSON.parse(PropertiesService.getScriptProperties().getProperty('Reminders') || '{}');
  const r = storage[id];
  if (!r) return;

  const next = new Date(r.utcMs);
  if (r.repeat === 'daily') next.setDate(next.getDate() + 1);
  else if (r.repeat === 'weekly') next.setDate(next.getDate() + 7);
  else if (r.repeat === 'monthly') next.setMonth(next.getMonth() + 1);

  r.utcMs = next.getTime();
  storage[id] = r;
  PropertiesService.getScriptProperties().setProperty('Reminders', JSON.stringify(storage));

  const t = ScriptApp.newTrigger("reminder_DeliveryService").timeBased().at(next).create();
  const mapping = JSON.parse(PropertiesService.getScriptProperties().getProperty('TriggerMap') || '{}');
  mapping[t.getUniqueId()] = id;
  PropertiesService.getScriptProperties().setProperty('TriggerMap', JSON.stringify(mapping));
}


function addIdea() {
  return {
    cardsV2: [{
      cardId: "add_idea",
      card: {
        "header": {
          "title": "Social Media Ideas Submitter",
          "subtitle": "Add inspiration to our ideas bank!",
          "imageUrl": "https://static.vecteezy.com/system/resources/thumbnails/014/568/141/small_2x/light-bulb-icon-light-bulb-ideas-and-creativity-analytical-thinking-for-innovation-processing-png.png",
          "imageType": "CIRCLE"
        },
        "sections": [
          {
            "collapsible": true,
            "uncollapsibleWidgetsCount": 7,
            "widgets": [
              {
                "textInput": {
                  "name": "reference_url",
                  "label": "Reference URL",
                  "validation": {
                    "inputType": "TEXT"
                  }
                }
              },
              {
                "textInput": {
                  "name": "notes",
                  "label": "Notes (E.g. reference for which client)",
                  "validation": {
                    "inputType": "TEXT"
                  }
                }
              },
              {
                "selectionInput": {
                  "name": "format",
                  "label": "Format",
                  "type": "DROPDOWN",
                  "items": [
                    {
                      "text": "Video",
                      "value": "video",
                      "selected": false
                    },
                    {
                      "text": "Infographic",
                      "value": "infographic",
                      "selected": false
                    },
                    {
                      "text": "Carousel",
                      "value": "carousel",
                      "selected": false
                    },
                    {
                      "text": "Static",
                      "value": "static",
                      "selected": false
                    }
                  ]
                }
              },
              {
                "selectionInput": {
                  "name": "trend",
                  "label": "Trend",
                  "type": "DROPDOWN",
                  "items": [
                    {
                      "text": "Yes",
                      "value": "yes",
                      "selected": false
                    },
                    {
                      "text": "No",
                      "value": "no",
                      "selected": false
                    }
                  ]
                }
              },
              {
                "textInput": {
                  "name": "profile_name",
                  "label": "Profile Name",
                  "validation": {
                    "inputType": "TEXT"
                  }
                }
              },
              {
                "buttonList": {
                  "buttons": [
                    {
                      "text": "Add to idea bank",
                      "color": {
                        "red": 0,
                        "green": 128,
                        "blue": 0,
                        "alpha": 50
                      },
                      "onClick": {
                        "action": {
                          "function": "onAddToIdeaBank"
                        }
                      }
                    }
                  ]
                }
              },
              {
                "textParagraph": {
                  "text": "<a href=https://docs.google.com/spreadsheets/d/1LzLTvGzDMpf18R3uH21HE9bnuFzk5nWew6pMgcqusdU/edit?gid=0#gid=0>Open the Ideas Bank</a>"
                }
              }
            ]
          }
        ]
      }
    }
    ]
  }
}

function onAddToIdeaBank(reference_url, notes, format, trend, profile_name) {
  values = [reference_url, trend, profile_name, notes, format];
  ss = SpreadsheetApp.openByUrl('https://docs.google.com/spreadsheets/d/1LzLTvGzDMpf18R3uH21HE9bnuFzk5nWew6pMgcqusdU/edit?gid=0#gid=0').getSheetByName('Content Ideas');
  last_row = (ss.getRange('A2:A').getValues().filter(String)).length;
  ss.getRange('A' + String(last_row + 2) + ':E' + String(last_row + 2)).setValues([values]);

}


function addUser() {
  var spaces = getSpacesForAll(); // Fetch the spaces dynamically

  var spaceItems = spaces.map(function (space) {
    Logger.log(space.displayName);
    return {
      text: space.displayName, // The name of the space
      value: space.name, // The space ID
      selected: false
    };
  });

  return {
    actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" },
    cardsV2: [{
      cardId: "addUser",
      card: {
        "header": {
          "title": "Add User to Google Chat Spaces",
          "subtitle": "Bulk add a user to Multiple Chat Spaces",
          "imageUrl": "https://drive.google.com/uc?&id=1gl8b6aB3uyxBcYQ5BllE8yrI6B07CHcQ",
          "imageType": "CIRCLE"
        },
        "sections": [
          {
            "header": "User's Email Address",
            "collapsible": true,
            "uncollapsibleWidgetsCount": 4,
            "widgets": [
              {
                "textInput": {
                  "name": "email_address",
                  "label": "User Email",
                  "validation": {
                    "inputType": "EMAIL"
                  }
                }
              },
              {
                "selectionInput": {
                  "name": "chat_spaces",
                  "label": "Select Chat Spaces",
                  "type": "CHECK_BOX",
                  "items": spaceItems // Dynamically populated spaces
                }
              }, {
                "divider": {}
              },
              {
                "buttonList": {
                  "buttons": [
                    {
                      "text": "Add to Spaces",
                      "color": {
                        "red": 0,
                        "green": 128,
                        "blue": 0,
                        "alpha": 50
                      },
                      "onClick": {
                        "action": {
                          "function": "onAddToSpaces"
                        }
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    }]
  }
}

// Function to get the current user's Google Chat spaces
function getSpacesForAll() {
  var spaces = [];
  try {
    var response = Chat.Spaces.list(); // Use Google Chat API to list spaces
    if (response.spaces && response.spaces.length > 0) {
      // Filter spaces that have a non-empty name and sort by name
      spaces = response.spaces.filter(function (space) {
        return space.displayName && space.displayName.trim() !== '';
      }).sort(function (a, b) {
        return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
      });
    }
  } catch (e) {
    Logger.log("Error fetching spaces: " + e.message);
  }
  return spaces;
}

// Function triggered when the button is clicked
function onAddToSpaces(email_address, selected_spaces) {
  if (email_address && selected_spaces) {
    const spaces = Array.isArray(selected_spaces) ? selected_spaces : [selected_spaces];
    
    if (spaces.length > 0) {
      let results = [];
      spaces.forEach(function (spaceId) {
        let result = addUserToSpace(email_address, spaceId);
        results.push(result);
      });
      return buildResponseCard("Process completed:\n" + results.join("\n"));
    }
  }
  return buildResponseCard("Please enter an email and select at least one space.");
}

// Function to add a user to a specific space
function addUserToSpace(email, spaceId) {
  Logger.log("Adding " + email + " to " + spaceId);

  try {
    var membership = {
      "member": {
        "name": "users/" + email,
        "type": "HUMAN"
      }
    };
    Chat.Spaces.Members.create(membership, spaceId);
    Logger.log('User added to space: ' + spaceId);
    return "✅ Added to " + spaceId;
  } catch (e) {
    let errorMsg = '❌ Failed for ' + spaceId + ': ' + e.message;
    Logger.log(errorMsg);
    return errorMsg;
  }
}

function addUserToSpaceTesting() {
  email = "pc@mediaone.co";
  spaceId = "spaces/AAAAnZQH1A8";

  try {
    var membership = {
      "member": {
        "name": "users/" + email,
        "type": "HUMAN"
      }
    };
    Chat.Spaces.Members.create(membership, spaceId);
    Logger.log('User added to space: ' + "");
  } catch (e) {
    Logger.log('Error adding user to space ' + spaceId + ': ' + e.message);
  }
}

function removeUser() {
  var spaces = getSpacesForAll(); // Fetch the spaces dynamically

  var spaceItems = spaces.map(function (space) {
    return {
      text: space.displayName, // The name of the space
      value: space.name, // The space ID
      selected: true
    };
  });

  return {
    cardsV2: [{
      cardId: "removeUser",
      card: {
        "header": {
          "title": "Remove User from Google Chat Spaces",
          "subtitle": "Bulk remove a user from Multiple Chat Spaces",
          "imageUrl": "https://drive.google.com/uc?&id=1gl8b6aB3uyxBcYQ5BllE8yrI6B07CHcQ",
          "imageType": "CIRCLE"
        },
        "sections": [
          {
            "header": "User's Email Address",
            "collapsible": true,
            "uncollapsibleWidgetsCount": 4,
            "widgets": [
              {
                "textInput": {
                  "name": "email_address",
                  "label": "User Email",
                  "validation": {
                    "inputType": "EMAIL"
                  }
                }
              },
              {
                "selectionInput": {
                  "name": "chat_spaces",
                  "label": "Select Chat Spaces",
                  "type": "CHECK_BOX",
                  "items": spaceItems // Dynamically populated spaces
                }
              }, {
                "divider": {}
              },
              {
                "buttonList": {
                  "buttons": [
                    {
                      "text": "Remove from Spaces",
                      "color": {
                        "red": 0,
                        "green": 128,
                        "blue": 0,
                        "alpha": 50
                      },
                      "onClick": {
                        "action": {
                          "function": "onRemoveFromSpaces"
                        }
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    }]
  }
}

function getSpacesForUser() {
  try {
    let spaces = [];
    let pageToken = null;

    do {
      let response = Chat.Spaces.list({
        pageSize: 100,  // Adjust page size as needed, up to 100
        pageToken: pageToken
      });

      if (response.spaces && response.spaces.length > 0) {
        spaces = spaces.concat(response.spaces);
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    // Filter and transform the spaces array to only include name and displayName.
    const filteredSpaces = spaces.map(space => ({
        name: space.name,
        displayName: space.displayName
    }));

    Logger.log(filteredSpaces)

    return filteredSpaces;

  } catch (e) {
    Logger.log("Error fetching spaces for user: " + e.message);
    // Log the full error object for more details
    Logger.log(e);
    return null; // Indicate an error occurred
  }
}


function onRemoveFromSpaces(email_address, selected_spaces) {
  if (email_address && selected_spaces) {
    const spaces = Array.isArray(selected_spaces) ? selected_spaces : [selected_spaces];

    if (spaces.length > 0) {
      let results = [];
      spaces.forEach(function (spaceId) {
        let result = removeUserFromSpace(email_address, spaceId);
        results.push(result);
      });
      return buildResponseCard("Process completed:\n" + results.join("\n"));
    }
  }
  return buildResponseCard("Please enter an email and select at least one space.");
}

function removeUserFromSpace(email, spaceId) {
  try {
    Chat.Spaces.Members.remove(spaceId + "/members/" + email);
    Logger.log('User removed from ' + spaceId);
    return "✅ Removed from " + spaceId;
  } catch (e) {
    let errorMsg = '❌ Failed for ' + spaceId + ': ' + e.message;
    Logger.log(errorMsg);
    return errorMsg;
  }
}

// Helper function to build a response card
function buildResponseCard(message) {
  return {
    cardsV2: [{
      cardId: "responseCard",
      card: {
        "sections": [
          {
            "widgets": [
              {
                "textParagraph": {
                  "text": message
                }
              }
            ]
          }
        ]
      }
    }]
  };
}

function multiSpaceQuery() {
  return {
    cardsV2: [{
      cardId: "multi_space_query",
      card: {
        "header": {
          "title": "Query Multiple Spaces",
          "subtitle": "You can specify the space names (separated by commas) in the first text field or leave it blank",
          "imageUrl": "https://drive.google.com/uc?&id=1COJt2Gg7Rt9qTMDu6vT8IrT67m4_pM0y",
          "imageType": "CIRCLE"
        },
        "sections": [
          {
            "header": "Google Spaces",
            "collapsible": false,
            "uncollapsibleWidgetsCount": 1,
            "widgets": [
              {
                "selectionInput": {
                  "name": "categories_spaces",
                  "label": "Categories / Spaces",
                  "type": "CHECK_BOX",
                  "items": [
                    {
                      "text": "Company-wide Spaces",
                      "value": "company",
                      "selected": false
                    },
                    {
                      "text": "My Team Spaces",
                      "value": "my_team",
                      "selected": true
                    },
                    {
                      "text": "Client / Partner Based",
                      "value": "client_partner",
                      "selected": false
                    }
                  ]
                }
              },
              {
                "textInput": {
                  "name": "custom_spaces",
                  "label": "Space Name(s) separated by comma(s)",
                  "onChangeAction": {
                    "function": "onChangeTextInput"
                  }
                }
              },
              {
                "textInput": {
                  "name": "user_query",
                  "label": "Your Query",
                  "onChangeAction": {
                    "function": "onChangeTextInput",
                    "requiredWidgets": [
                      "user_query"
                    ]
                  }
                }
              },
              {
                "buttonList": {
                  "buttons": [
                    {
                      "text": "Submit",
                      "color": {
                        "red": 100,
                        "green": 128,
                        "blue": 80,
                        "alpha": 1
                      },
                      "onClick": {
                        "openLink": {
                          "url": "https://developers.google.com/chat/ui/widgets/button-list"
                        }
                      },
                      "disabled": false
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    }]
  };
}

function query_card() {
  return {
    cardsV2: [
      {
        cardId: "query_card_form",
        card: {
          header: {
            title: "Guided Bot Query",
            subtitle: "A more targeted query!",
            imageUrl:
              "https://drive.google.com/uc?&id=1COJt2Gg7Rt9qTMDu6vT8IrT67m4_pM0y",
            imageType: "CIRCLE",
          },
          sections: [
            {
              header: "Select where the information should be pulled from:",
              collapsible: true,
              uncollapsibleWidgetsCount: 3,
              widgets: [
                {
                  selectionInput: {
                    name: "sources",
                    label: "Sources",
                    type: "CHECK_BOX",
                    items: [
                      {
                        text: "monday.com",
                        value: "monday",
                        selected: false,
                      },
                      {
                        text: "MediaOne FAQs",
                        value: "mo_faq",
                        selected: true,
                      },
                      {
                        text: "Google Drive",
                        value: "drive",
                        selected: false,
                      },
                      {
                        text: "This space/channel conversation history",
                        value: "space_history",
                        selected: false,
                      },
                    ],
                  },
                },
                {
                  textInput: {
                    name: "user_query",
                    label:
                      "Your question",
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Submit",
                        color: {
                          red: 0,
                          green: 128,
                          blue: 200,
                          alpha: 10,
                        },
                        onClick: {
                          action: {
                            function: "targeted_query",
                          },
                        },
                        disabled: false,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function help_commands() {
  return {
    cardsV2: [
      {
        cardId: "helpCommands",
        card: {
          header: {
            title: "MOBot",
            subtitle: "Available Bot Commands",
            imageUrl:
              "https://drive.google.com/uc?&id=1COJt2Gg7Rt9qTMDu6vT8IrT67m4_pM0y",
            imageType: "CIRCLE",
          },
          sections: [
            {
              header: "ask",
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: [
                {
                  textParagraph: {
                    text: "Queries the MediaOne FAQ Database or Gemini if the FAQ does not have the answer.\n\nExample:\n@MOBot ask what seo tools does MediaOne use?",
                  },
                },
              ],
            },
            {
              header: "history",
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: [
                {
                  textParagraph: {
                    text: "Allows you to query the content of the last 1000 messages in the Google Chat space/channel.\n\nExample:\n@MOBot history Summarise the messages into key actionable points.",
                  },
                },
              ],
            },
            {
              header: "reminders",
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: [
                {
                  textParagraph: {
                    text: "Manage reminders for this space.\n\nCommands:\n/remind - Open the reminder setup card.\n/listreminders - View and delete your active reminders.",
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function targeted_query(sources, question, space, user) {
  const service = getService_();

  if (sources.includes('mo_faq')) {
    moFaqQuery(space, question, user)
  }

  if (sources.includes('space_history')) {
    spaceHistoryQuery(space, question, user);
  }

  if (sources.includes('drive')) {
    message = { 'text': 'Getting a list of your Google Drive files...' }
    Chat.Spaces.Messages.create(
      message,
      space,
      // Authenticate with the service account token.
      { Authorization: "Bearer " + service.getAccessToken() },
    );
    googleDriveQuery(space, question, user);
  }

  if (sources.includes('monday')) {
  }
  return

}

function onCardClick(event) {
  try {
    const fn = event.common.invokedFunction;
    
    if (fn === "reminder_SubmitAction") return reminder_SubmitAction(event);
    if (fn === "reminder_ListAction") return reminder_ListCard(event.space.name);
    if (fn === "reminder_DeleteAction") return reminder_DeleteAction(event);

    if (fn === "targeted_query") {
      const question = fetchFormValue(event, "user_query");
      const sources = fetchFormValue(event, "sources");
      targeted_query(sources, question, event.space.name, event.user.displayName);
      return { actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" }, text: "🔍 Searching sources... result will post shortly." };
    } 
    
    if (fn === "onAddToSpaces") return onAddToSpaces(fetchFormValue(event, "email_address"), fetchFormValue(event, "chat_spaces"));
    if (fn === "onRemoveFromSpaces") return onRemoveFromSpaces(fetchFormValue(event, "email_address"), fetchFormValue(event, "chat_spaces"));
    
    if (fn === "onAddToIdeaBank") {
      onAddToIdeaBank(fetchFormValue(event, "reference_url"), fetchFormValue(event, "notes"), fetchFormValue(event, "format"), fetchFormValue(event, "trend"), fetchFormValue(event, "profile_name"));
      return buildResponseCard("✅ Idea added to the bank!");
    }

    return { text: "Unknown interaction: " + fn };
  } catch (err) {
    return { actionResponse: { type: "NEW_MESSAGE", responseType: "PRIVATE" }, text: "❌ Interaction error: " + err.message };
  }
}


function fetchFormValue(event, widgetName) {
  try {
    const input = event.common.formInputs[widgetName];
    if (!input || !input[""]) return null;
    
    const val = input[""];
    if (val.stringInputs && val.stringInputs.value) {
      const values = val.stringInputs.value;
      // If it's a multi-selection (checkbox), return the whole array.
      // If it's a single selection or text input, return the first string.
      return values.length > 1 ? values : values[0];
    }
    if (val.dateTimeInput) {
      return val.dateTimeInput.msSinceEpoch;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function getDriveFiles() {
  files = DriveApp.getFilesByName('drive_files.txt');
  file = files.next();
  const jsonString = file.getBlob().getDataAsString();
  // Parse the JSON string into a dictionary
  // Optionally, return the dictionary
  return jsonString;
}

function googleDrive2() {
  var files = DriveApp.getFiles();
  drive_list = '';
  while (files.hasNext()) {
    var file = files.next();
    drive_list += file.getName() + ": " + (String(file.getUrl()).replaceAll('/edit?usp=drivesdk', '') + '\n');
  }

  // Define the file name and location in Google Drive
  const fileName = 'drive_files.txt';
  //const folderId = 'YOUR_FOLDER_ID'; // Replace with your folder ID

  // Create a new file in Google Drive
  const new_file = DriveApp.createFile(fileName, drive_list);

  Logger.log('File created successfully!');
}

function googleDriveQuery(space, query, user) {
  drive_dict = getDriveFiles();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyAkYBqT7uSa7BfbeKpb0xBTFrfHeU9oF34`;

  // Construct the request body
  const querystring = {
    contents: [
      {
        parts: [
          {
            text:
              "Return any file (filenames and urls) in this Google Drive directory that might be relevant to the query, '" +
              query +
              "'. Here are the files: " + drive_dict
          },
        ],
        role: "user",
      },
    ],
  };

  // Send the request
  const response = UrlFetchApp.fetch(url, {
    "muteHttpExceptions": true,
    method: "post",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(querystring),
  });

  // Parse the response
  const responseJson = JSON.parse(response.getContentText());

  Logger.log(responseJson);

  message = { 'text': "Google Drive Results\n" + responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", "") }

  const service = getService_();

  Chat.Spaces.Messages.create(
    message,
    space,
    {},
    // Authenticate with the service account token.
    { Authorization: "Bearer " + service.getAccessToken() },
  );

  logging(query, responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", ""), user);
}

function spaceHistoryQuery(space, query, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyAkYBqT7uSa7BfbeKpb0xBTFrfHeU9oF34`;
  const result = Chat.Spaces.Messages.list(space, { pageSize: 1000 });
  history = "";
  for (i = 0; i < result["messages"].length; i++) {
    history += result["messages"][i]["formattedText"] + "\n";
  }
  // Construct the request body
  const querystring = {
    contents: [
      {
        parts: [
          {
            text:
              "Using the content of the chat history, " +
              query +
              ". Here is the chat: " +
              history,
          },
        ],
        role: "user",
      },
    ],
  };
  // Send the request
  const response = UrlFetchApp.fetch(url, {
    "muteHttpExceptions": true,
    method: "post",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(querystring),
  });
  // Parse the response
  const responseJson = JSON.parse(response.getContentText());
  Logger.log(responseJson);
  message = { 'text': "This Space's Results\n" + responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", "") }
  const service = getService_();
  Chat.Spaces.Messages.create(
    message,
    space,
    {},
    // Authenticate with the service account token.
    { Authorization: "Bearer " + service.getAccessToken() },
  );
  logging(query, responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", ""), user);
  return
}

function moFaqQuery(space, query, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyAkYBqT7uSa7BfbeKpb0xBTFrfHeU9oF34`;
  const ss = SpreadsheetApp.openByUrl(
    "https://docs.google.com/spreadsheets/d/1aiAaELbN-pv9jq_CQ1TDoWazRTcVPCFGX-N8Dr_1UEY/"
  );

  sheet_names = [
    "FINANCE_Client",
    "SEM_Client",
    "SEO_Client",
    "Content/SMM_Client",
    "Sales_Client",
    "General_Internal",
    "Knowledge",
  ];

  let dataString = "";

  for (sheet_no = 0; sheet_no < sheet_names.length; sheet_no++) {
    sheet = ss.getSheetByName(sheet_names[sheet_no]);
    const data = sheet.getDataRange().getValues();

    for (const row of data) {
      dataString += row.join(",") + "\n";
    }
  }
  Logger.log(dataString);
  // Construct the request body
  const querystring = {
    contents: [
      {
        parts: [
          {
            text:
              "Try using the FAQ to answer the following query, if not, generate an answer '" +
              query +
              "'. Here is the FAQ: " +
              dataString,
          },
        ],
        role: "user",
      },
    ],
  };
  // Send the request
  const response = UrlFetchApp.fetch(url, {
    "muteHttpExceptions": true,
    method: "post",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(querystring),
  });
  // Parse the response
  const responseJson = JSON.parse(response.getContentText());
  Logger.log(responseJson);
  message = { 'text': "MO FAQs Results\n" + responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", "") }
  const service = getService_();
  Chat.Spaces.Messages.create(
    message,
    space,
    {},
    // Authenticate with the service account token.
    { Authorization: "Bearer " + service.getAccessToken() },
  );

  logging(query, responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", ""), user);
  return
}

function multipleSpaceQuery(space, query) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyAkYBqT7uSa7BfbeKpb0xBTFrfHeU9oF34`;
  const result = Chat.Spaces.Messages.list(space, { pageSize: 1000 });
  history = "";
  for (i = 0; i < result["messages"].length; i++) {
    history += result["messages"][i]["formattedText"] + "\n";
  }
  // Construct the request body
  const querystring = {
    contents: [
      {
        parts: [
          {
            text:
              "Using the content of the chat history, " +
              query +
              ". Here is the chat: " +
              history,
          },
        ],
        role: "user",
      },
    ],
  };
  // Send the request
  const response = UrlFetchApp.fetch(url, {
    "muteHttpExceptions": true,
    method: "post",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(querystring),
  });
  // Parse the response
  const responseJson = JSON.parse(response.getContentText());
  Logger.log(responseJson);
  message = { 'text': responseJson["candidates"][0]["content"]["parts"][0]["text"].replaceAll("**", "") }
  const service = getService_();
  Chat.Spaces.Messages.create(
    message,
    space,
    {},
    // Authenticate with the service account token.
    { Authorization: "Bearer " + service.getAccessToken() },
  );
}

function logging(question, answer, user) {
  ss = SpreadsheetApp.openByUrl("https://docs.google.com/spreadsheets/d/1aiAaELbN-pv9jq_CQ1TDoWazRTcVPCFGX-N8Dr_1UEY/");

  new_row = (ss.getSheetByName('Log').getRange("A1:A").getValues().filter(String).length) + 1;

  ss.getSheetByName('Log').getRange("A" + String(new_row)).setValue(question);
  ss.getSheetByName('Log').getRange("B" + String(new_row)).setValue(answer);
  ss.getSheetByName('Log').getRange("E" + String(new_row)).setValue(user);
}