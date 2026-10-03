require('dotenv').config();
const mongoose = require('mongoose');
const Actor = require('../src/models/actor');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_NAME || 'XomPhim' });
  const result = await Actor.deleteMany({ slug: { $in: ['chung-shu-kai', 'tom-cruise'] } });
  console.log('Deleted', result.deletedCount, 'test actors');
  await mongoose.disconnect();
  process.exit(0);
})();