'use strict';

function waitForPostgresWrites(res, flush) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const sendJson = body => {
    const currentSend = res.send;
    res.send = originalSend;
    try { return originalJson(body); }
    finally { res.send = currentSend; }
  };
  const sendDatabaseError = error => {
    if (res.headersSent) return;
    if (error.code === 'CRM_CONCURRENT_UPDATE') {
      res.statusCode = 409;
      sendJson({ error: error.message });
      return;
    }
    console.error('CRM PostgreSQL write failed:', error.message);
    res.statusCode = 503;
    sendJson({ error: 'Database write failed. Please retry after the database connection is restored.' });
  };

  res.json = body => {
    flush().then(() => sendJson(body)).catch(sendDatabaseError);
    return res;
  };
  res.send = body => {
    flush().then(() => originalSend(body)).catch(sendDatabaseError);
    return res;
  };
}

module.exports = { waitForPostgresWrites };
