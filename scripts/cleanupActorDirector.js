require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function cleanupOldFields() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔗 Connected to MongoDB\n');

  const db = mongoose.connection.db;

  const actorFieldsToRemove = [
    'birthName', 'placeOfBirth', 'nationality', 'height',
    'coverImage', 'biography', 'knownFor', 'debutYear',
    'activeYears', 'awards', 'socialMedia', 'popularity',
    'viewCount', 'isVerified', 'filmingStyle', 'genres'
  ];

  const directorFieldsToRemove = [
    'birthName', 'placeOfBirth', 'nationality', 'height',
    'coverImage', 'biography', 'knownFor', 'debutYear',
    'activeYears', 'awards', 'socialMedia', 'popularity',
    'viewCount', 'isVerified', 'filmingStyle', 'genres'
  ];

  // ========== CLEANUP ACTORS ==========
  console.log('📋 Actors: Xóa các field cũ...');
  
  const actorUnset = {};
  for (const field of actorFieldsToRemove) {
    actorUnset[field] = 1;
  }
  
  const actorResult = await db.collection('actors').updateMany(
    {},
    { $unset: actorUnset }
  );
  console.log(`✅ Đã cleanup ${actorResult.modifiedCount} actors`);

  // ========== CLEANUP DIRECTORS ==========
  console.log('\n📋 Directors: Xóa các field cũ...');
  
  const directorUnset = {};
  for (const field of directorFieldsToRemove) {
    directorUnset[field] = 1;
  }
  
  const directorResult = await db.collection('directors').updateMany(
    {},
    { $unset: directorUnset }
  );
  console.log(`✅ Đã cleanup ${directorResult.modifiedCount} directors`);

  // ========== VERIFY ==========
  console.log('\n📊 Sample Actor:');
  const sampleActor = await db.collection('actors').findOne({}, { projection: { name: 1, profileImage: 1, dateOfBirth: 1, gender: 1 } });
  console.log(JSON.stringify(sampleActor, null, 2));

  console.log('\n📊 Sample Director:');
  const sampleDirector = await db.collection('directors').findOne({}, { projection: { name: 1, profileImage: 1, dateOfBirth: 1, gender: 1 } });
  console.log(JSON.stringify(sampleDirector, null, 2));

  await mongoose.disconnect();
  console.log('\n✅ Cleanup hoàn tất!');
}

cleanupOldFields().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
