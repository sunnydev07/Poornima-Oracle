
const { Pinecone } = require('@pinecone-database/pinecone');

async function testPinecone() {
  const apiKey = 'pcsk_7NPFks_QZFn9niEoFxaw9oxQANqXFbNU1eBduzX84mcLf85dbQCad86CbApKj6k6pbVpBn';
  const indexName = 'databaseinjson';

  console.log('Testing Pinecone API key...\n');

  try {
    // Step 1: Initialize Pinecone client
    console.log('1. Initializing Pinecone client...');
    const pinecone = new Pinecone({ apiKey });
    console.log('   Client initialized successfully.\n');

    // Step 2: List indexes to verify API key works
    console.log('2. Listing indexes to verify API key...');
    const indexList = await pinecone.listIndexes();
    console.log('   API key is valid!\n');
    console.log('   Available indexes:', JSON.stringify(indexList, null, 2), '\n');

    // Step 3: Check if the specific index exists
    console.log(`3. Checking if index "${indexName}" exists...`);
    const indexes = indexList.indexes || [];
    const targetIndex = indexes.find(idx => idx.name === indexName);

    if (targetIndex) {
      console.log(`   Index "${indexName}" found!`);
      console.log('   Index details:', JSON.stringify(targetIndex, null, 2), '\n');

      // Step 4: Try to connect to the index and run a simple query
      console.log(`4. Connecting to index "${indexName}" and running test query...`);
      const index = pinecone.index(indexName);

      // Query with a zero vector (all zeros) - just to test connectivity
      // We'll use a 768-dim vector (based on your server.js embedding config)
      const testVector = new Array(768).fill(0);
      const queryResult = await index.query({
        topK: 1,
        vector: testVector,
        includeMetadata: true,
      });

      console.log('   Query successful!');
      console.log('   Matches found:', queryResult.matches?.length || 0);
      if (queryResult.matches?.length > 0) {
        console.log('   Sample match:', JSON.stringify(queryResult.matches[0], null, 2));
      }
      console.log('\n✅ All Pinecone tests passed! Keys are working.');
    } else {
      console.log(`   Index "${indexName}" NOT found.`);
      console.log('   Available indexes:', indexes.map(i => i.name).join(', '));
      console.log('\n❌ The index "databaseinjson" does not exist in your Pinecone account.');
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.code) {
      console.error('   Status code:', error.code);
    }
    if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized') || error.message.toLowerCase().includes('invalid api key')) {
      console.error('\n   The API key is invalid or expired.');
    } else if (error.message.includes('403') || error.message.toLowerCase().includes('forbidden')) {
      console.error('\n   The API key does not have permission to access this resource.');
    } else if (error.message.includes('404') || error.message.toLowerCase().includes('not found')) {
      console.error('\n   The requested resource was not found.');
    }
  }
}

testPinecone();
