// SCOPE, CREDENTIALS, and getService_ are already defined in Code.gs


// The space to create the message in.
//
// Replace SPACE_NAME with a space name.
// Obtain the space name from the spaces resource of Chat API,
// or from a space's URL.
const PARENT = 'spaces/AAAAnZQH1A8'

/**
 * Authenticates with Chat API via app credentials, then posts a message.
 */
function createMessageWithAppCredentials() {
  try {
    const service = getService_();
    if (!service.hasAccess()) {
      console.error(service.getLastError());
      return;
    }

    // Specify the message to create.
    const message = {'text': 'Hello world!'};

    // Call Chat API with a service account to create a message.
    const result = Chat.Spaces.Messages.create(
        message,
        PARENT,
        {},
        // Authenticate with the service account token.
        {'Authorization': 'Bearer ' + service.getAccessToken()});

    // Log details about the created message.
    console.log(result);

  } catch (err) {
    // TODO (developer) - Handle exception.
    console.log('Failed to create message with error %s', err.message);
  }
}
