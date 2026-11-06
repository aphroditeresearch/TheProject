// GET /api/logout → ends the session and returns to the sign-in page.
const { clearCookie, SESSION_COOKIE, redirect } = require('./_lib');

module.exports = async (req, res) => {
  redirect(res, '/', [clearCookie(SESSION_COOKIE)]);
};
