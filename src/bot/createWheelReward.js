require('dotenv').config();

const { createReward } = require('./twitchApi');

async function main() {
    const reward = await createReward({
        broadcasterId: process.env.BROADCASTER_ID,
        title: process.env.WHEEL_REWARD_TITLE || 'Крутить колесо',
        cost: Number(process.env.WHEEL_REWARD_COST) || 500,
        prompt: process.env.WHEEL_REWARD_PROMPT || 'Активация колеса выбора',
        isUserInputRequired: false,
        accessToken: process.env.TWITCH_TOKEN_MY,
        clientId: process.env.CLIENT_ID_MY
    });

    console.log(`Награда создана: ${reward.title}`);
    console.log(`WHEEL_REWARD_ID=${reward.id}`);
}

main().catch(error => {
    console.error('Не удалось создать награду колеса:', error.message);
    process.exitCode = 1;
});
