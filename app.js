//==============================================================================
// SETUP
//==============================================================================

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request');
// Send API error codes: https://developers.facebook.com/docs/messenger-platform/send-api-reference
const MESSAGE_NOT_SENT = 1545041;

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({
  verify: verifyRequestSignature
}));
app.use(express.static('public'));

//==============================================================================
// DATABASE
//==============================================================================
var mongoose = require('mongoose');
mongoose.Promise = global.Promise;
mongoose.connect(process.env.MONGODB_URI);
var db = mongoose.connection;
db.on('error', console.error.bind(console, '[DB] connection error:'));
db.once('open', function() {
  // we're connected!
  console.log("[DB] Successfully connected to database.");
});

var Users = require('./models/user.js');
var Posts = require('./models/post.js');
var Polls = require('./models/poll.js');
var States = require('./states.js');

//==============================================================================
// CONFIG VALUES
//==============================================================================

/*
 * Be sure to setup your config values before running this code. You can
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

//==============================================================================
// SERVER ENDPOINTS
//==============================================================================

/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("[VALIDATION] Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("[ERROR] Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function(req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("[WARNING] Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
      .update(buf)
      .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

//==============================================================================
// MESSAGE RECEIVING FUNCTIONS
//==============================================================================

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  // Received message for user senderID and page recipientID at time = timeOfMessage // log(JSON.stringify(message))
  console.log("[RECEIVED_MESSAGE] USER_ID: %d | MID: %s", senderID, message.mid);
  console.log(JSON.stringify(message));
  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("[RECEIVED_MESSAGE] ECHO | Received echo for message %s and app %d with metadata %s",
      messageId, appId, metadata);
    return;
  }

  Users.get_user(senderID, function(err, user) {
    if (err) { return console.error(err); }
    if (user) { // USER CASE
      if (messageText) { // IF TEXT MESSAGE
        switch (user.state) {
          // If we receive a text message, check to see if it matches any special
          // keywords and send back the corresponding example. Otherwise, just echo
          // the text we received.
          case States.POLL_INPUT_CONTINUE:
            switch (messageText) {
              case 'Another one':
                continuePollInput(senderID);
                break;
              case 'Publish poll':
                publishPoll(senderID);
                break;
            }
            break;
          case States.POLL_INPUT_CHOICE:
            createChoice(senderID, messageText);
            break;
          case States.POLL_INPUT_QUESTION:
            createPoll(senderID, messageText);
            break;
          case States.POSTING:
            postMessage(senderID, messageText);
            break;
          default:
            switch (messageText) {
              case 'Unsubscribe':
              case 'unsubscribe':
                removeUser(senderID);
                break;
              case 'Pin post':
              case 'pin post':
                newPost(senderID);
                break;
              case 'View posts':
              case 'view posts':
                viewPosts(senderID);
                break;
              case 'Start poll':
              case 'start poll':
                newPoll(senderID);
                break;
              case 'View polls':
              case 'view polls':
                viewPolls(senderID);
                break;
              case 'Help':
              case 'help':
                sendHelpMessage(senderID);
                break;
              default:
                // sendTextMessage(senderID, messageText);
                sendTextMessageChannel(senderID, user.name + ": " + messageText);
            }
        }
      } else if (messageAttachments) { // IF NON-TEXT MESSAGE
        sendTextMessageChannel(senderID, user.name + ":");
        for (var i = 0; i < messageAttachments.length; i++) {
            var msgPayload = messageAttachments[i].payload;
            if (msgPayload.sticker_id) {
              msgPayload = { url: msgPayload.url }
            }
            sendAttachmentMessageChannel(senderID, messageAttachments[i].type, msgPayload)
        }
      }
    } else { // NO USER CASE
      if (messageText) { // IF TEXT MESSAGE
        switch (messageText) {
          case 'Subscribe':
          case 'subscribe':
            registerUser(senderID);
            break;
          default:
            sendTextMessage(senderID, "You are not subscribed to any channels. " +
              "Please subscribe before sending a message.");
        }
      } else if (messageAttachments) { // IF NON-TEXT MESSAGE
        sendTextMessage(senderID, "You are not subscribed to any channels. " +
          "Please subscribe before sending a message.");
      }
    }
  });
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      // Received delivery confirmation for message ID: messageID
      console.log("[DELIVERED_MESSAGE] MID: %s", messageID);
    });
  }

  console.log("[DELIVERED_MESSAGE] All message before %d were delivered.", watermark);
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 * This event is also called when Get Started is clicked.
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = JSON.parse(event.postback.payload);
  console.log("[POSTBACK] Received postback | type: %s.", payload.type);

  switch (payload.type) {
    case "NEW_USER":
      registerUser(senderID);
      sendTextMessage(senderID, "Hi! I'm Grubot, your group chat assistant - " +
        "What can I do for you?");
      break;
    case "DELETE_POST":
      deletePost(senderID, payload.postID);
      break;

    default:
      console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload.type, timeOfPostback);
      // When a postback is called, we'll send a message back to the sender to
      // let them know it was successful
      sendTextMessage(senderID, "Postback called");
      break;
  }
}

function registerUser(uid) {
  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    if (user) {
      console.log("[WARNING] Can't add user %s that is already registered.", uid);
      sendTextMessage(uid, "You are already subscribed to a channel.");
    } else {
      request({
        uri: 'https://graph.facebook.com/v2.6/' + uid,
        qs: {
          access_token: PAGE_ACCESS_TOKEN,
          fields: 'first_name,last_name,locale,timezone,gender'
        },
        method: 'GET'
      }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
          body = JSON.parse(body);
          console.log('[GRAPH_API] retrieved user register info.', body);
          Users.add_user(uid, States.DEFAULT, body.first_name, body.last_name,
            body.timezone, body.gender,
            function(err, newUser) {
              if (err) { return console.error(err); }
              console.log("[REGISTER_USER] %s | %s | %s || has been registered.",
                newUser.name, newUser.id, newUser.gender);
              sendTextMessage(uid, "You have joined the channel.");
              sendTextMessageChannel(uid, newUser.name + ' has joined!');
            });
        } else {
          console.error("[ERROR] Failed calling Graph API.", response.statusCode, response.statusMessage, body.error);
        }
      });
    }
  });
}

function removeUser(uid) {
  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    if (user) {
      Users.remove_user(uid, function(err) {
        if (err) { return console.error(err); }
        console.log("[REMOVE_USER] Successfully removed user %s.", uid);
        sendTextMessage(uid, "You have left the channel.");
        sendTextMessageChannel(uid, user.name + " left the channel.");
      });
    } else {
      console.log("[WARNING] Can't remove user %s which is not in the database.", uid);
      sendTextMessage(uid, "You are not subscribed to any channels.");
    }
  });
}

function postMessage(uid, message) {
  console.log("[POST] Attempting to create post '%s' from User %s", message, uid);
  Users.set_user_state(uid, States.DEFAULT, "posting message");
  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    Posts.add_post(user.name, message, function(err, newPost) {
      if (err) { return console.error(err); }
      console.log("[POST] Added Post by User %s: '%s'", uid, newPost.text);
      onPostSuccess(user, newPost.text);
    });
  });
}

function onPostSuccess(user, post) {
  console.log("[SEND_POST_SUCCESS] Sending post success.");
  var viewPostsOption = [{
    content_type: 'text',
    title: 'View posts',
    payload: ''
  }];
  sendTextMessage(user.id, "Got it.");
  viewPosts(user.id);
  sendQuickReplyChannel(user.id, user.name + " posted a message.", viewPostsOption);
}

function newPost(uid) {
  console.log("[POST] Request to post from User %s", uid);
  Users.set_user_state(uid, States.POSTING, 'starting new post');
  sendTextMessage(uid, "What message would you like to post?");
}

function viewPosts(uid) {
  console.log("[POST] User %s viewing all posts", uid);
  Posts.get_all_posts(function(err, posts) {
    if (err) { console.error(err); }
    if (posts.length === 0) {
      sendTextMessage(uid, "There are no posts to view.");
    } else if (posts.length === 1) {
      var buttons = [{
        type: "postback",
        title: "Delete post",
        payload: JSON.stringify({
          type: "DELETE_POST",
          postID: posts[0]._id
        })
      }];
      var elements = [{
        title: posts[0].text,
        subtitle: posts[0].owner,
        buttons: buttons
      }];
      sendGenericMessage(uid, elements);
    } else {
      var listItems = posts.map(function(post) {
        return {
          title: post.text,
          subtitle: post.owner,
          buttons: [{
            type: "postback",
            title: "Delete",
            payload: JSON.stringify({
              type: "DELETE_POST",
              postID: post._id
            })
          }]
        };
      });
      if (listItems.length > 4) {
        sendListMessage(uid, listItems.slice(-4), true);
      } else {
        sendListMessage(uid, listItems, true);
      }
    }
  });
}

function deletePost(uid, postID) {
  Posts.remove_post(postID, function(err) {
    if (err) { console.error(err); }
    console.log("[POST] Post %s deleted by User %s", postID, uid);
    viewPosts(uid);
  });
}

function newPoll(uid) {
  console.log("[POLL] User %s building poll", uid);
  Users.set_user_state(uid, States.POLL_INPUT_QUESTION, "starting poll");
  sendTextMessage(uid, "What would you like to ask the channel?");
}

function createPoll(ownerId, question) {
  Users.get_user(ownerId, function(err, user) {
    if (err) { console.error(err); }
    Polls.add_poll(user.name, question, function(err, newPoll) {
      if (err) { console.error(err); }
      console.log("[POLL] Poll %s created by User %s", newPoll.id, ownerId);
      user.buildingPollId = newPoll.id;
      user.state = States.POLL_INPUT_CHOICE;
      user.save(function(err, savedUser) {
        if (err) { return console.error(err); }
        if (savedUser.state != States.POLL_INPUT_CHOICE) {
          console.error("[ERROR] State of user: %s after creating poll is not POLL_INPUT_CHOICE.", savedUser.state);
        }
        sendTextMessage(ownerId, "Cool. What's the first poll choice?");
      });
    });
  });
}

function createChoice(uid, choice) {
  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    Polls.add_choice(choice, user.buildingPollId, function(err, newChoice) {
      if (err) { return console.error(err); }
      console.log("[POLL] Choice %s created by User %s", newChoice.id, uid);
      user.state = States.POLL_INPUT_CONTINUE;
      user.save(function(err, savedUser) {
        if (err) { return console.error(err); }
          // advance user after state is set
          var replies = [{
            "content_type": "text",
            "title": "Another one",
            "payload": ""
          }, {
            "content_type": "text",
            "title": "Publish poll",
            "payload": ""
          }];
          sendQuickReply(uid, "Want to add another choice?", replies);
      });
    });
  });
}

function continuePollInput(uid) {
  Users.set_user_state(uid, States.POLL_INPUT_CHOICE, 'adding another choice');
  sendTextMessage(uid, "OK, what's the next choice?");
}

function publishPoll(uid) {
  Users.set_user_state(uid, States.DEFAULT, 'publishing poll');
  Users.get_user(uid, function(err, user) {
    var viewPollsOption = [{
      content_type: 'text',
      title: 'View polls',
      payload: ''
    }];
    var pollId = user.buildingPollId;
    sendTextMessage(uid, "Your poll is live!");
    // viewPolls(uid);
    viewPoll(uid, pollId);
    sendQuickReplyChannel(uid, user.name + " just published a poll!", viewPollsOption);
    user.buildingPollId = "";
    user.save(function(err, savedUser) {
      if (err) { console.error(err); }
    });
  });
}

function viewPolls(uid) {
  Polls.get_all_polls(function(err, polls) {
    if (err) { console.error(err); }
    var listItems = polls.map(function(poll) {
      return {
        title: poll.text,
        subtitle: 'asked by ' + poll.owner,
        buttons: [{
          type: "postback",
          title: "View poll",
          payload: JSON.stringify({
            type: "VIEW_POLL",
            pollID: poll._id
          })
        }]
      };
    });
    sendListMessage(uid, listItems, true);
  });
}

function viewPoll(uid, pollId) {
  console.log("[DEBUG] checking poll id: %s", pollId);
  Polls.get_poll(pollId, function(err, poll) {
    if (err) { console.error(err); }
    Polls.get_poll_choices(pollId, function(err, choices) {
      var pollItem = [{
        title: poll.text,
        subtitle: 'asked by ' + poll.owner,
        image_url: 'http://www.qsc.com/resource-files//productresources/spk/kla/kla181/q_spk_kla_181_img_pole2.png',
        buttons: [{
          type: "postback",
          title: "Delete poll",
          payload: JSON.stringify({
            type: "DELETE_POLL",
            pollID: poll._id // check this
          })
        }]
      }];
      var choiceItems = choices.map(function(choice) {
        return {
          title: choice.text,
          buttons: [{
            type: "postback",
            title: "Vote",
            payload: JSON.stringify({
              type: "POLL_VOTE",
              pollID: poll._id, // check this
              choiceID: choice._id // check this
            })
          }]
        };
      });
      var listItems = pollItem.concat(choiceItems);

      sendListMessage(uid, listItems);
    });
  });
}


function sendHelpMessage(uid) {
  console.log("[HELP] sending Help menu to user %s", uid);
  sendTextMessage(uid, "'Pin post': pin a message for everyone to see\n" +
                        "'View posts': view pinned messages\n" +
                        "'Start poll': create a new poll\n" +
                        "'Subscribe': receive updates from Grubot\n" +
                        "'Unsubscribe': stop receiving updates");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  // Received message read event for watermark: watermark and sequence number: sequenceNumber
  console.log("[MESSAGE_READ] WATERMARK: %d | SEQ_NUM: %d", watermark, sequenceNumber);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam,
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

//==============================================================================
// MESSAGE SENDING FUNCTIONS
//==============================================================================
/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message to all users in channel.
 *
 */
function sendTextMessageChannel(senderID, messageText) {
  Users.get_other_users(senderID, function(err, users) {
    if (err) { return console.error(err); }
    if (users) {
      for (var i = 0; i < users.length; i++) {
        sendTextMessage(users[i].id, messageText);
      }
    }
  });
}

/*
 * Send an attachment using the Send API.
 *
 */
function sendAttachmentMessage(recipientId, msgType, msgPayload) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: msgType,
        payload: msgPayload
      }
    }
  };

  callSendAPI(messageData);
}

function sendAttachmentMessageChannel(senderID, msgType, msgPayload) {
  Users.get_other_users(senderID, function(err, users) {
    if (err) { return console.error(err); }
    if (users) {
      for (var i = 0; i < users.length; i++) {
        sendAttachmentMessage(users[i].id, msgType, msgPayload);
      }
    }
  });
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, messageText, messageButtons) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: messageText,
          buttons: messageButtons
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a list message using the Send API.
 *
 */
function sendListMessage(recipientId, listItems, isCompact) {
  var topElementStyle = isCompact ? 'compact' : 'large';
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "list",
          top_element_style: topElementStyle,
          elements: listItems
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId, messageElements) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: messageElements
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId, messageText, quickReplies) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      quick_replies: quickReplies
    }
  };

  callSendAPI(messageData);
}
/*
 * Send a message with Quick Reply buttons to all users in a channel.
 *
 */
function sendQuickReplyChannel(senderID, messageText, quickReplies) {
  Users.get_other_users(senderID, function(err, users) {
    if (err) { return console.error(err); }
    if (users) {
      for (var i = 0; i < users.length; i++) {
        sendQuickReply(users[i].id, messageText, quickReplies);
      }
    }
  });
}

//==============================================================================
// SEND API
//==============================================================================

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: {
      access_token: PAGE_ACCESS_TOKEN
    },
    method: 'POST',
    json: messageData

  }, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        // Successfully sent message with id: messageId, to recipient: recipientId
        console.log("[SEND_API] MID: %s | USER_ID: %s", messageId, recipientId);
      } else {
        // Successfully called Send API for recipient: recipientId
        console.log("[SEND_API] USER_ID: %s", recipientId);
      }
    } else {
      // TODO: commented this out since it was spamming for some reason
      // Scroll up until you see "CLEANUP_DELETED_CONVO" in logs
      // clean up users that have deleted bot's convo
      // if (body.error.error_subcode === MESSAGE_NOT_SENT) {
      //   var uid = JSON.parse(response.request.body).recipient.id;
      //   console.log("[CLEANUP_DELETED_CONVO] Removing unable to reach user %d", uid);
      //   removeUser(uid);
      // }
      console.error("[SEND_API|ERROR] Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('[APP] Node app is running on port', app.get('port'));
});

module.exports = app;
