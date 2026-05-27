const { mutateState, payload } = require('./_lib/runtime');

function bodyFrom(request) {
  if (!request.body) return {};
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  return request.body;
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { event, data = {} } = bodyFrom(request);
    const state = await mutateState(event, data);
    response.status(200).json(payload(state));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
};
