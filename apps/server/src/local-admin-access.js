export function localAdminAccess(port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req, res, next) => {
    const host = req.get('host');
    const peer = req.socket.remoteAddress;
    const origin = req.get('origin');
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(peer) || !hosts.has(host) ||
        req.get('sec-fetch-site') === 'cross-site' || (origin && ![...hosts].some(h => origin === `http://${h}`))) {
      return res.status(403).json({error:'Local admin is accessible only from this computer.'});
    }
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({error:'Local admin is read-only.'});
    next();
  };
}
