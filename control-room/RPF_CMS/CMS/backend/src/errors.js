class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Kept for the original incidentService / legacy routes.
class ServiceError extends HttpError {}

const badRequest = (m) => new HttpError(400, m);
const unauthorized = (m = 'authentication required') => new HttpError(401, m);
const forbidden = (m = 'not allowed') => new HttpError(403, m);
const notFound = (m = 'not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, ServiceError, badRequest, unauthorized, forbidden, notFound, conflict, wrap };
