/**
 * Vercel Serverless Function acting as a CORS proxy.
 * Resolves CORS blocks when communicating client-side with a self-hosted BookOrbit instance.
 */
export default async function handler(req, res) {
  // CORS configuration headers for client response
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-kobo-synctoken, x-kobo-apitoken, x-kobo-sync');
  res.setHeader('Access-Control-Expose-Headers', 'x-kobo-synctoken, x-kobo-sync');

  // Handle preflight options request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url } = req.query;
  if (!url) {
    res.status(400).json({ error: 'Missing target url parameter' });
    return;
  }

  try {
    const headers = {};
    // Forward headers from client to BookOrbit
    const headersToForward = [
      'content-type',
      'user-agent',
      'x-kobo-synctoken',
      'x-kobo-apitoken',
      'x-kobo-sync'
    ];
    for (const h of headersToForward) {
      const val = req.headers[h];
      if (val) {
        headers[h] = val;
      }
    }

    const fetchOptions = {
      method: req.method,
      headers
    };

    // Forward request body if necessary
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
    }

    const targetResponse = await fetch(url, fetchOptions);
    const contentType = targetResponse.headers.get('content-type') || '';

    // Copy relevant headers back from BookOrbit to client response
    const koboHeaders = ['x-kobo-synctoken', 'x-kobo-sync'];
    for (const h of koboHeaders) {
      const val = targetResponse.headers.get(h);
      if (val) {
        res.setHeader(h, val);
      }
    }

    res.status(targetResponse.status);

    if (contentType.includes('application/json')) {
      const data = await targetResponse.json();
      res.json(data);
    } else {
      // Forward binary streams (EPUBs / Cover images)
      const buffer = await targetResponse.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.send(Buffer.from(buffer));
    }
  } catch (error) {
    console.error('[Proxy Error]', error);
    res.status(500).json({ error: error.message || 'Failed to proxy request' });
  }
}
