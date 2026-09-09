/**
 * Tests for services/crawler/pdf-extractor.js
 */

const assert = require('assert');
const {
  isPdfOrDriveUrl,
  extractGoogleDriveId,
  getDownloadUrls,
  cleanPdfText,
  parsePdfBuffer,
  extractNoticePdfText,
  enrichNoticesWithPdfContent,
} = require('./services/crawler/pdf-extractor');

async function runTests() {
  console.log('--- Starting PDF Extractor Tests ---');

  // Test 1: URL Detection
  console.log('Test 1: isPdfOrDriveUrl');
  assert.strictEqual(isPdfOrDriveUrl('https://drive.google.com/file/d/1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j/view?usp=sharing'), true);
  assert.strictEqual(isPdfOrDriveUrl('https://drive.google.com/open?id=1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j'), true);
  assert.strictEqual(isPdfOrDriveUrl('https://docs.google.com/document/d/1abc123/edit'), true);
  assert.strictEqual(isPdfOrDriveUrl('https://poornima.org/public/uploads/circular.pdf'), true);
  assert.strictEqual(isPdfOrDriveUrl('https://poornima.org/public/uploads/circular.PDF?v=2'), true);
  assert.strictEqual(isPdfOrDriveUrl('https://calendar.google.com/calendar/embed?src=xyz'), false);
  assert.strictEqual(isPdfOrDriveUrl('https://firstindia.co.in/news/some-article'), false);
  assert.strictEqual(isPdfOrDriveUrl('https://facebook.com/reel/12345'), false);
  assert.strictEqual(isPdfOrDriveUrl(''), false);
  assert.strictEqual(isPdfOrDriveUrl(null), false);
  console.log('✓ Test 1 passed');

  // Test 2: Google Drive ID Extraction
  console.log('Test 2: extractGoogleDriveId');
  assert.strictEqual(
    extractGoogleDriveId('https://drive.google.com/file/d/1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j/view?usp=sharing'),
    '1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j'
  );
  assert.strictEqual(
    extractGoogleDriveId('https://drive.google.com/open?id=1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j'),
    '1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j'
  );
  assert.strictEqual(
    extractGoogleDriveId('https://docs.google.com/document/d/my-doc-id-123/edit'),
    'my-doc-id-123'
  );
  assert.strictEqual(extractGoogleDriveId('https://poornima.org/circular.pdf'), null);
  console.log('✓ Test 2 passed');

  // Test 3: Download URLs construction
  console.log('Test 3: getDownloadUrls');
  const urls = getDownloadUrls('https://drive.google.com/file/d/TEST_ID/view');
  assert.strictEqual(urls.length, 2);
  assert.strictEqual(urls[0], 'https://drive.usercontent.google.com/download?id=TEST_ID&export=download&confirm=t');
  assert.strictEqual(urls[1], 'https://drive.google.com/uc?export=download&id=TEST_ID&confirm=t');
  const directUrls = getDownloadUrls('https://poornima.org/public/circular.pdf');
  assert.strictEqual(directUrls[0], 'https://poornima.org/public/circular.pdf');
  console.log('✓ Test 3 passed');

  // Test 4: Text Cleaning
  console.log('Test 4: cleanPdfText');
  const rawSample = 'Header\r\n\r\n-- 1 of 5 --\r\n\r\nLine 1   with   spaces\t\tand tabs\n\n\n\nLine 2';
  const cleaned = cleanPdfText(rawSample);
  assert.ok(!cleaned.includes('-- 1 of 5 --'));
  assert.ok(!cleaned.includes('\r'));
  assert.ok(!cleaned.includes('   '));
  assert.ok(cleaned.includes('Line 1 with spaces and tabs'));
  assert.ok(cleaned.includes('Line 2'));
  console.log('✓ Test 4 passed');

  // Test 5: Plain text buffer parsing
  console.log('Test 5: parsePdfBuffer with plain text');
  const textBuf = Buffer.from('This is a test document with sufficient characters to pass the minimum text threshold of forty characters easily.');
  const textResult = await parsePdfBuffer(textBuf);
  assert.strictEqual(textResult.success, true);
  assert.ok(textResult.text.includes('test document'));
  console.log('✓ Test 5 passed');

  // Test 6: Scanned / empty PDF detection (insufficient text)
  console.log('Test 6: parsePdfBuffer with empty/insufficient content');
  const emptyBuf = Buffer.from('short');
  const emptyResult = await parsePdfBuffer(emptyBuf);
  assert.strictEqual(emptyResult.success, false);
  console.log('✓ Test 6 passed');

  // Test 7: Real Google Drive PDF extraction
  console.log('Test 7: Real Google Drive PDF extraction');
  const realNoticeUrl = 'https://drive.google.com/file/d/1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j/view?usp=sharing';
  const extractResult = await extractNoticePdfText(realNoticeUrl);
  assert.strictEqual(extractResult.success, true);
  assert.ok(extractResult.charCount > 1000);
  assert.ok(extractResult.text.includes('Fee') || extractResult.text.includes('fee'));
  console.log(`✓ Test 7 passed (Extracted ${extractResult.charCount} characters from real PU circular)`);

  // Test 8: Enrichment of notices array
  console.log('Test 8: enrichNoticesWithPdfContent');
  const sampleNotices = [
    {
      title: 'Fees Notice Session 2026-27 (Higher Class)',
      url: 'https://drive.google.com/file/d/1Tcl3ZV0z0j6LGYn0N9npTOLHIV4nXP_j/view?usp=sharing',
      text: 'Fees Notice Session 2026-27 (Higher Class) [NEW]',
      college: 'PU',
      category: 'fee',
      publishedAt: '2026-07-01',
    },
    {
      title: 'Academic Calendar',
      url: 'https://calendar.google.com/calendar/embed?src=c_xyz',
      text: 'Academic Calendar',
      college: 'PU',
      category: 'academic',
      publishedAt: '2026-07-01',
    },
  ];

  const enriched = await enrichNoticesWithPdfContent(sampleNotices, { concurrency: 2, delayMs: 50 });
  assert.strictEqual(enriched.length, 2);
  assert.strictEqual(enriched[0].pdfExtracted, true);
  assert.ok(enriched[0].pdfCharCount > 1000);
  assert.ok(enriched[0].text.includes('--- Circular Content ---'));
  assert.strictEqual(enriched[1].pdfExtracted, false);
  console.log('✓ Test 8 passed');

  console.log('\n==========================================');
  console.log('ALL PDF EXTRACTOR UNIT TESTS PASSED! 🎉');
  console.log('==========================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
