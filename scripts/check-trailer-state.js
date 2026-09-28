require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { Movie } = require('../src/models');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const total = await Movie.countDocuments({});
  const withTrailer = await Movie.countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  const noTrailer = await Movie.countDocuments({
    $or: [
      { trailer: null },
      { trailer: { $exists: false } },
      { 'trailer.key': '' },
      { 'trailer.key': null }
    ]
  });
  const conan = await Movie.countDocuments({ 'trailer.key': 'Jrt1aUU2_Xs' });
  const tia = await Movie.countDocuments({ name: 'Tia Sáng Của Ngày Mai' });
  console.log({ total, withTrailer, noTrailer, conan, tia });
  await mongoose.disconnect();
})();
