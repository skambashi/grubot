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

const
  DEFAULT_STATE = 'DEFAULT_STATE',
  POSTING_STATE = 'POSTING_STATE';
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
var mongoose = require('mongoose'),
  autoIncrement = require('mongoose-auto-increment');
mongoose.Promise = global.Promise;
mongoose.connect(process.env.MONGODB_URI);
var db = mongoose.connection;
db.on('error', console.error.bind(console, '[DB] connection error:'));
db.once('open', function() {
  // we're connected!
  console.log("[DB] Successfully connected to database.");
});
autoIncrement.initialize(db);

var Users = require('./models/user.js');
var Posts = require('./models/post.js');

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
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("[RECEIVED_MESSAGE] QUICKREPLY | Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
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
          case POSTING_STATE:
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
                promptPost(senderID);
                break;
              case 'View posts':
              case 'view posts':
                viewPosts(senderID);
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
  console.log("[DEBUG] checking payload", payload);

  switch (payload.type) {
    case "NEW_USER":
      registerUser(senderID);
      sendTextMessage(senderID, "Hi! I'm Grubot, your group chat assistant - " +
        "What can I do for you?");
      break;
    case "VIEW_POSTS":
      viewPosts(senderID);
    case "DELETE_POST":
      deletePost(senderID, payload.postID);

    default:
      console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);
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
          Users.add_user(uid, DEFAULT_STATE, body.first_name, body.last_name,
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

  // Count isn't updated right away due to async push to mongodb.
  // Need to wait a bit to call Users.count to get right number.
  // Users.count(function(err, count){
  //   if (err) { return console.error(err); }
  //   console.log("[REGISTER_USER] Registered user count: %d.", count);
  // });

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
  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    Posts.add_post(user.first_name, message, function(err) {
      if (err) { return console.error(err); }
      sendPostSuccess(user, message);
      console.log("[POST] Added Post by User %s: '%s'", uid, message);
    });
    user.state = DEFAULT_STATE;
    user.save(function(err, savedUser) {
      if (err) { return console.error(err); }
      if (savedUser.state != DEFAULT_STATE) {
        console.error("[ERROR] State of user: %s after posting message is not DEFAULT_STATE.", savedUser.state);
      }
    });
  });
}

function sendPostSuccess(user, post) {
  var button = [{
    type: "postback",
    title: "View posts",
    payload: JSON.stringify({
      type: "VIEW_POSTS"
    })
  }];
  // var viewPostReply = [{
  //   "content_type": "text",
  //   "title": "View posts",
  //   "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
  // }];
  sendButtonMessage(user.id, "Your message has been posted.", button);
  // sendQuickReply(user.id, "Your message has been posted.", viewPostReply);
  sendTextMessageChannel(user.first_name + " posted a message: " + post);
}

function promptPost(uid) {
  console.log("[POST] Request to post from User %s", uid);
  sendTextMessage(uid, "What would you like to post to the channel?");

  Users.get_user(uid, function(err, user) {
    if (err) { return console.error(err); }
    user.state = POSTING_STATE;
    user.save(function(err, savedUser) {
      if (err) { return console.error(err); }
      if (savedUser.state != POSTING_STATE) {
        console.error("[ERROR] State of user: %s after posting message is not POSTING_STATE.", savedUser.state);
      }
    });
  });
}

function viewPosts(uid) {
  console.log("[POST] User %s viewing all posts", uid);
  Posts.get_all_posts(function(err, posts) {
    if (err) { console.error(err); }
    var listItems = posts.map(function(post) {
      return {
        title: post.text,
        subtitle: post.owner,
        buttons: [{
          title: "Delete",
          type: "postback",
          payload: JSON.stringify({
            type: "DELETE_POST",
            postID: post.id
          })
        }]
      };
    });
    sendListMessage(uid, listItems);
  });
}

function deletePost(uid, postID) {
  console.log("[POST] Post %d deleted by User %s", postID, uid);
  Posts.remove_post(postID);
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
function sendListMessage(recipientId, listItems) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "list",
          top_element_style: "compact",
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
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random() * 1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",
          timestamp: "1428444852",
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
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
function sendQuickReply(recipientId, quickReplies) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: quickReplies
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  // Sending a read receipt to mark message as seen

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  // Turning typing indicator on

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  // Turning typing indicator off

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons: [{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
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
