const { defaultState, mutateState, payload } = require('./_lib/runtime');

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const state = await mutateState('tournament:reset', defaultState());
    response.status(200).json(payload(state));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
};
