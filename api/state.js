const { payload, readState } = require('./_lib/runtime');

module.exports = async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const state = await readState();
    response.status(200).json(payload(state));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
};
