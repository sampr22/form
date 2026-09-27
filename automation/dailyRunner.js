import { heartbeat, redisFromEnv } from './scheduler.js';

async function main() {
  const redis = redisFromEnv();
  try {
    const result = await heartbeat(redis);
    console.log(JSON.stringify({
      dueSchedules: result.dueSchedules.map((item) => ({
        id: item.id,
        label: item.label,
        time: item.time,
        mode: item.mode
      }))
    }));
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error('[SCHEDULER][ERROR]', error?.stack || error);
  process.exit(1);
});
