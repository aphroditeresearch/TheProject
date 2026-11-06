// The built-in lessons. They live on the server (files starting with "_" are never sent to the
// browser), so locked lesson titles can't be read from the page source. Once you save from the
// Admin tab, what's saved in Redis replaces this.
//
// Who can sign in: anyone with the Awakened, Illuminated or Enlightened role (Grounded is free
// Discord access only and can't sign in to the site). Admins can always sign in.
//
// How far a member gets:
//   Awakened role    → Awakened, one lesson (or lesson part) at a time
//   finishing the last Awakened homework            → Illuminated opens on the site
//   Illuminated role → Awakened already done + Illuminated one at a time
//   finishing Illuminated → member can ask for promotion with a payout certificate (Profile tab);
//                           an admin approves it → Enlightened opens
//   Enlightened role → everything below already done + Enlightened one at a time
const ROLES = {
  grounded: '1546326599119671407',
  awakened: '1546326866875646084',
  illuminated: '1554996401979654165',
  enlightened: '1546326926099222538',
};

const hw = (t) => 'Find three examples of ' + t + ' on your own charts. Upload screenshots of each one and explain what you saw and why it matters.';
const partHw = (lesson, part) => (/^Part \d+$/.test(part)
  ? 'Write up what ' + lesson + ' ' + part.toLowerCase() + ' covered, then find two examples on your own charts and upload screenshots of them.'
  : 'Write up what ' + part + ' covered, then upload screenshots that show it on your own charts.');

// A lesson is a title, or [title, [part titles]] for lessons that branch into several videos.
const chapter = (id, name, role, list, extra) => Object.assign({
  id, name, role,
  lessons: list.map((x, i) => {
    const title = Array.isArray(x) ? x[0] : x;
    const lid = id + '-' + (i + 1);
    const l = { id: lid, title, video: '', summary: '', homework: Array.isArray(x) ? '' : hw(title) };
    if (Array.isArray(x)) l.parts = x[1].map((p, j) => ({ id: lid + 'p' + (j + 1), title: p, video: '', summary: '', homework: partHw(title, p) }));
    return l;
  }),
}, extra || {});

const parts = (n) => Array.from({ length: n }, (_, i) => 'Part ' + (i + 1));

const CURRICULUM = [
  chapter('ch1', 'Awakened', ROLES.awakened, [
    'Before You Begin', 'The Beginning', 'Candles & Timeframes', 'Trends', 'Displacement', 'Accumulation',
    ['Liquidity', parts(2)], ['Manipulation', parts(3)], ['Ranges', parts(2)], 'Internal Manipulation', 'Confirmation', 'Continuations',
    'Entries, SL & TP', 'Sessions', 'Checklist', ['Order Blocks', parts(4)], 'AMD', 'News', 'Structure', 'Entry Triggers',
    'HTF', ['Start of Many', ['Start of Many', 'Breakeven Protocol']], 'Narrative', 'Protection', 'Identification', ['Conclusion', ['Mark Ups', 'Conclusion']],
  ]),
  chapter('ch2', 'Illuminated', ROLES.illuminated, ['AMD V2', 'Entry Models', 'Your Next Steps']),
  // promotion: members only reach this chapter with the role, or when an admin approves their payout certificate
  chapter('ch3', 'Enlightened', ROLES.enlightened, [
    'SMT / POI', 'Inducements', 'Orderflow', 'Time IDM', 'NQ', 'News V2', 'Divergence', 'HTF V2', 'SMT V2',
  ], { promotion: true }),
];
// A lesson can carry an announcement banner shown above its video (title, message, optional link).
const SESSIONS_NOTICE = { title: 'Indicator Announcement', body: 'The indicator that goes with this section is now available. Open the link for the details and how to set it up.', link: '' };
CURRICULUM[0].lessons.find((l) => l.title === 'Sessions').notice = SESSIONS_NOTICE;
// The first two lessons are about getting started, so their homework is lighter.
CURRICULUM[0].lessons[0].homework = 'Write down why you joined The Project and what you want to be able to do by the end of Awakened.';
CURRICULUM[0].lessons[1].homework = 'Summarise the lesson in your own words: the three ideas you want to remember.';

const DEFAULT_SETTINGS = { unlockMode: 'submit' };   // 'submit' = next opens on hand-in; 'approve' = after an admin approves

module.exports = { ROLES, CURRICULUM, DEFAULT_SETTINGS, SESSIONS_NOTICE };
