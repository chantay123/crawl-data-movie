require('dotenv').config();
const mongoose = require('mongoose');
const ActorService = require('../src/services/ActorService');
const Actor = require('../src/models/actor');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_NAME || 'XomPhim' });
    console.log('MongoDB connected');

    const testName = 'Chung Shu-Kai';

    console.log('\n[1] First call: enrichWithWikidata("' + testName + '")');
    const first = await ActorService.enrichWithWikidata(testName);
    if (first) {
      console.log('  ->', JSON.stringify({
        _id: first._id.toString(),
        name: first.name,
        slug: first.slug,
        profileImage: first.profileImage ? '[OK ' + first.profileImage.slice(0, 60) + '...]' : '[MISSING]',
        gender: first.gender,
        source: first.source,
        externalId: first.externalId,
      }, null, 2));
    } else {
      console.log('  -> null');
    }

    await new Promise(r => setTimeout(r, 5000));

    console.log('\n[2] Idempotent call: enrichWithWikidata("' + testName + '")');
    const second = await ActorService.enrichWithWikidata(testName);
    if (second) {
      console.log('  ->', JSON.stringify({
        _id: second._id.toString(),
        profileImage: second.profileImage ? '[OK ' + second.profileImage.slice(0, 60) + '...]' : '[MISSING]',
        gender: second.gender,
      }, null, 2));
    } else {
      console.log('  -> null');
    }

    const ok = first && second && first.profileImage === second.profileImage && first.gender === second.gender;
    console.log('\n[RESULT]', ok ? 'PASSED (data preserved)' : (first && second) ? 'CHECK (changed: image=' + (first.profileImage !== second.profileImage) + ', gender=' + (first.gender !== second.gender) + ')' : 'SKIPPED (one call returned null)');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('ERROR', err.message);
    process.exit(1);
  }
})();