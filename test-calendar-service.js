/**
 * Unit tests for services/calendar-service.js
 */

const assert = require('assert');
const {
  parseICalContent,
  categorizeEvent,
  enrichEventWithCountdown,
  getUpcomingCalendarEvents,
  getCalendarContextForPrompt,
} = require('./services/calendar-service');

async function runTests() {
  console.log('--- Starting Calendar Service Tests ---');

  // Test 1: Event Categorization
  console.log('Test 1: categorizeEvent');
  assert.strictEqual(categorizeEvent('Mid Term Examination 2026'), 'exam');
  assert.strictEqual(categorizeEvent('MSE: III Sem B.Tech'), 'exam');
  assert.strictEqual(categorizeEvent('End Term Practical Exam'), 'exam');
  assert.strictEqual(categorizeEvent('Diwali Holiday Break'), 'holiday');
  assert.strictEqual(categorizeEvent('Cultural Fest Celebration'), 'event');
  assert.strictEqual(categorizeEvent('Annual Sports Fest Lakshya'), 'event');
  assert.strictEqual(categorizeEvent('Poornima Group - No Uniform Day'), 'event');
  assert.strictEqual(categorizeEvent('Commencement of Academic Session'), 'academic');
  console.log('✓ Test 1 passed');

  // Test 2: iCal Parsing
  console.log('Test 2: parseICalContent');
  const sampleICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260924
DTEND;VALUE=DATE:20260925
SUMMARY:CIE-I : All First Year & Final Year Program
DESCRIPTION:Continuous Internal Evaluation 1
END:VEVENT
BEGIN:VEVENT
DTSTART:20261018T040000Z
DTEND:20261026T120000Z
SUMMARY:Diwali Holiday
DESCRIPTION:Festival of Lights
END:VEVENT
END:VCALENDAR`;

  const parsed = parseICalContent(sampleICS, { name: 'PU Academic', college: 'PU', defaultCategory: 'academic' });
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].title, 'CIE-I : All First Year & Final Year Program');
  assert.strictEqual(parsed[0].startDate, '2026-09-24');
  assert.strictEqual(parsed[0].category, 'exam');
  assert.strictEqual(parsed[0].college, 'PU');
  assert.strictEqual(parsed[1].title, 'Diwali Holiday');
  assert.strictEqual(parsed[1].startDate, '2026-10-18');
  assert.strictEqual(parsed[1].category, 'holiday');
  console.log('✓ Test 2 passed');

  // Test 3: Countdown & Relative Date Label
  console.log('Test 3: enrichEventWithCountdown');
  const ev1 = enrichEventWithCountdown({ startDate: '2026-09-09', title: 'Today Exam' }, '2026-09-09');
  assert.strictEqual(ev1.daysRemaining, 0);
  assert.strictEqual(ev1.countdownLabel, 'Today!');
  assert.strictEqual(ev1.isToday, true);

  const ev2 = enrichEventWithCountdown({ startDate: '2026-09-10', title: 'Tomorrow Exam' }, '2026-09-09');
  assert.strictEqual(ev2.daysRemaining, 1);
  assert.strictEqual(ev2.countdownLabel, 'Tomorrow');

  const ev3 = enrichEventWithCountdown({ startDate: '2026-09-14', title: 'Next Week Event' }, '2026-09-09');
  assert.strictEqual(ev3.daysRemaining, 5);
  assert.strictEqual(ev3.countdownLabel, 'In 5 days');
  console.log('✓ Test 3 passed');

  // Test 4: Live Calendar Query & Filtering
  console.log('Test 4: getUpcomingCalendarEvents (live)');
  const res = await getUpcomingCalendarEvents({
    currentDate: '2026-09-09',
    limit: 5,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.today, '2026-09-09');
  assert.ok(Array.isArray(res.upcoming));
  assert.ok(res.upcoming.length > 0);
  assert.ok(res.counts.total > 0);
  console.log(`✓ Test 4 passed (${res.upcoming.length} events returned, ${res.counts.total} total upcoming)`);

  // Test 5: College Filter
  console.log('Test 5: College filtering');
  const puRes = await getUpcomingCalendarEvents({
    college: 'PU',
    currentDate: '2026-09-09',
    limit: 5,
  });
  assert.strictEqual(puRes.ok, true);
  assert.ok(puRes.upcoming.every((e) => e.college === 'PU' || e.college === 'GENERAL'));
  console.log('✓ Test 5 passed');

  // Test 6: Prompt Context Generation
  console.log('Test 6: getCalendarContextForPrompt');
  const promptContext = await getCalendarContextForPrompt('PU', 3);
  assert.ok(typeof promptContext === 'string');
  assert.ok(promptContext.includes('Official Upcoming Academic Deadlines'));
  console.log('✓ Test 6 passed');

  console.log('\n==========================================');
  console.log('ALL CALENDAR SERVICE TESTS PASSED! 🎉');
  console.log('==========================================\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
