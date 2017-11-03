'use strict';

const functions = require('firebase-functions');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
var request = require('request');

// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.GCLOUD_PROJECT}.firebaseio.com`
});

// // Scopes to request.
const OAUTH_REDIRECT_URI = `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com/popup.html`;
const OAUTH_SCOPES = ['basic'];

// Example of multiple scopes:
// const OAUTH_SCOPES = ['ageless+basic+event_management+group_edit+group_content_edit+group_join+profile_edit+reporting+rsvp+messaging'];

function meetupOAuth2Client() {
  // Meetup OAuth 2 setup
  // TODO: Configure the `meetup.client_id` and `meetup.client_secret` Google Cloud environment variables.
  const credentials = {
    client: {
      id: functions.config().meetup.client_id,
      secret: functions.config().meetup.client_secret
    },
    auth: {
      tokenHost: 'https://secure.meetup.com',
      tokenPath: '/oauth2/access',
      authorizePath: '/oauth2/authorize'
    }
  };
  return require('simple-oauth2').create(credentials);
}

/**
 * Redirects the User to the Meetup authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
exports.redirect = functions.https.onRequest((req, res) => {
  const oauth2 = meetupOAuth2Client();

  const redirectUri = oauth2.authorizationCode.authorizeURL({
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES
  });
  console.log('Redirecting to:', redirectUri.replace(/%2B/g, '+'));
  res.redirect(redirectUri.replace(/%2B/g, '+'));
});

/**
 * Exchanges a given Meetup auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The Firebase custom auth token is sent back in a JSONP callback function with function name defined by the
 * 'callback' query parameter.
 */
exports.token = functions.https.onRequest((req, res) => {
  const oauth2 = meetupOAuth2Client();

  try {
    console.log('Received auth code:', req.query.code);
    oauth2.authorizationCode.getToken({
      code: req.query.code,
      redirect_uri: OAUTH_REDIRECT_URI
    }).then(results => {
      console.log('Auth code exchange result received:', results);

      // We have an Meetup access token and the user identity now.
      request.get({ url: 'https://api.meetup.com/2/member/self/?access_token=' + results.access_token }, ((error, response, body) => {
        if (error) {
          console.log(error)
        }
        const data = JSON.parse(body);
        const accessToken = results.access_token;
        const meetupUserID = data['id'];
        const profilePic = data['photo']['photo_link'];
        const userName = data['name'];

        // Create a Firebase account and get the Custom Auth Token.
        createFirebaseAccount(meetupUserID, userName, profilePic, accessToken).then(firebaseToken => {
          // Serve an HTML page that signs the user in and updates the user profile.
          res.jsonp({ token: firebaseToken });
        });
      }))
    });
  } catch (error) {
    return res.jsonp({ error: error.toString });
  }
});

/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /meetupAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
function createFirebaseAccount(meetupUserID, displayName, photoURL, accessToken) {
  // The UID we'll assign to the user.
  const uid = `meetup:${meetupUserID}`;

  // Save the access token tot he Firebase Realtime Database.
  const databaseTask = admin.database().ref(`/meetupAccessToken/${uid}`)
    .set(accessToken);

  // Create or update the user account.
  const userCreationTask = admin.auth().updateUser(uid, {
    displayName: displayName,
    photoURL: photoURL
  }).catch(error => {
    // If user does not exists we create it.
    if (error.code === 'auth/user-not-found') {
      return admin.auth().createUser({
        uid: uid,
        displayName: displayName,
        photoURL: photoURL
      });
    }
    throw error;
  });

  // Wait for all async task to complete then generate and return a custom auth token.
  return Promise.all([userCreationTask, databaseTask]).then(() => {
    // Create a Firebase custom auth token.
    return admin.auth().createCustomToken(uid).then((token) => {
      console.log('Created Custom token for UID "', uid, '" Token:', token);
      return token;
    });
  });
}
