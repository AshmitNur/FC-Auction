module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  response.status(400).json({ error: 'Use /api/action with tournament:reset and an admin user.' });
};
