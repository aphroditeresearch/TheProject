// The built-in lessons. They live on the server (files starting with "_" are never sent to the
// browser), so locked lesson titles can't be read from the page source. Once you save from the
// Admin tab, what's saved in Redis replaces this.
//
// Chapters are a ladder: a member's one Discord role sets how far up they are.
//   Awakened role    → Awakened
//   Illuminated role → Awakened (already done) + Illuminated
//   Enlightened role → Awakened + Illuminated (already done) + Enlightened
const ROLES = {
  awakened: '1546326866875646084',
  illuminated: '1554996401979654165',
  enlightened: '1546326926099222538',
};

const hw = (t) => 'Find three examples of ' + t + ' on your own charts. Screenshot or link each one and explain what you saw and why it matters.';
const chapter = (id, name, role, titles) => ({
  id, name, role,
  lessons: titles.map((t, i) => ({ id: id + '-' + (i + 1), title: t, video: '', summary: '', homework: hw(t) })),
});

const CURRICULUM = [
  chapter('ch1', 'Awakened', ROLES.awakened, [
    'Before You Begin', 'The Beginning', 'Candles & Timeframes', 'Trends', 'Displacement', 'Accumulation',
    'Liquidity', 'Manipulation', 'Ranges', 'Internal Manipulation', 'Confirmation', 'Continuations',
    'Entries, SL & TP', 'Sessions', 'Checklist', 'Order Blocks', 'AMD', 'News', 'Structure', 'Entry Triggers',
    'HTF', 'Start of Many', 'Narrative', 'Protection', 'Identification', 'Conclusion',
  ]),
  chapter('ch2', 'Illuminated', ROLES.illuminated, ['AMD V2', 'Entry Models', 'Your Next Steps']),
  chapter('ch3', 'Enlightened', ROLES.enlightened, [
    'SMT / POI', 'Inducements', 'Orderflow', 'Time IDM', 'NQ', 'News V2', 'Divergence', 'HTF V2', 'SMT V2',
  ]),
];
// The first two lessons are about getting started, so their homework is lighter.
CURRICULUM[0].lessons[0].homework = 'Write down why you joined The Project and what you want to be able to do by the end of Awakened.';
CURRICULUM[0].lessons[1].homework = 'Summarise the lesson in your own words: the three ideas you want to remember.';

const DEFAULT_SETTINGS = { unlockMode: 'submit' };   // 'submit' = next lesson opens on hand-in; 'approve' = after an admin approves

module.exports = { ROLES, CURRICULUM, DEFAULT_SETTINGS };
