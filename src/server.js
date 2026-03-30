const { app } = require('./app');
const { env } = require('./config/env');

app.listen(env.port, () => {
  console.log(`EduQuest API running on port ${env.port}`);
});
