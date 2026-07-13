// netlify/functions/config.js
// Returns Firebase config to the frontend (env vars are never exposed to the browser directly)
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  const projectId    = process.env.FIREBASE_PROJECT_ID;
  const apiKey       = process.env.FIREBASE_API_KEY;
  const authDomain   = process.env.FIREBASE_AUTH_DOMAIN;
  const appId        = process.env.FIREBASE_APP_ID;
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID;
  const storageBucket     = process.env.FIREBASE_STORAGE_BUCKET;

  if (!projectId || !apiKey) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Firebase env vars not configured' }),
    };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      firebase: {
        apiKey,
        authDomain:        authDomain       || `${projectId}.firebaseapp.com`,
        projectId,
        storageBucket:     storageBucket    || `${projectId}.appspot.com`,
        messagingSenderId: messagingSenderId || '',
        appId,
      },
    }),
  };
};
