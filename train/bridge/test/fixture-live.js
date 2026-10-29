// keeps the fixture "recording" (segments + GPS) until killed
const f = require('./fixture');
f.startLive([1, 2, 3]);
console.log('live fixture running');
setInterval(() => {}, 1e6);
