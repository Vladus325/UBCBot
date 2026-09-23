const OBSWebSocket = require('obs-websocket-js').default;
const obs = new OBSWebSocket();

let isConnected = false;
let reconnectInterval = null;

function scheduleReconnect() {
    if (!reconnectInterval) {
        reconnectInterval = setInterval(attemptReconnect, 60000);
    }
}

async function attemptReconnect() {
    if (isConnected) {
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
        return;
    }

    try {
        await obs.connect('ws://localhost:4455', process.env.OBS_PASSWORD);
        console.log('✅ Подключено к OBS');
        isConnected = true;

        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    } catch (err) {
        console.warn('⚠️ Попытка подключения к OBS не удалась, попробуем через минуту:', err.message);
        scheduleReconnect();
    }
}

async function connectOBS() {
    obs.on('ConnectionClosed', () => {
        console.log('❌ Подключение к OBS закрыто');
        isConnected = false;
        scheduleReconnect();
    });

    obs.on('ConnectionError', (err) => {
        console.error('❌ Ошибка подключения к OBS:', err.message);
        isConnected = false;
        scheduleReconnect();
    });

    await attemptReconnect();
}

async function playRewardMedia(rewardName) {
    if (!isConnected) {
        console.log('⚠️ OBS не подключен, пропускаем воспроизведение награды:', rewardName);
        return;
    }

    try {
        await obs.call('TriggerMediaInputAction', {
            inputName: rewardName, // имя источника в OBS
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        });
        console.log('🎬 Воспроизведена награда:', rewardName);
    } catch (err) {
        console.error('❌ Ошибка воспроизведения награды:', err.message);
    }
}

async function switchScene(sceneName) {
    if (!isConnected) {
        console.log('⚠️ OBS не подключен, пропускаем смену сцены:', sceneName);
        return;
    }

    try {
        await obs.call('SetCurrentProgramScene', {
            sceneName: sceneName
        });
        console.log('🎭 Смена сцены:', sceneName);
    } catch (err) {
        console.error('❌ Ошибка смены сцены:', err.message);
    }
}

async function setSourceVisibility(sourceName, visible) {
    if (!isConnected) {
        console.log(`⚠️ OBS не подключен, пропускаем изменение видимости источника: ${sourceName}`);
        return;
    }

    try {
        const currentScene = await obs.call('GetCurrentProgramScene');
        const sceneName = currentScene.sceneName;

        const idResponse = await obs.call('GetSceneItemId', {
            sceneName,
            sourceName
        });

        await obs.call('SetSceneItemEnabled', {
            sceneName,
            sceneItemId: idResponse.sceneItemId,
            sceneItemEnabled: visible
        });

        console.log(`OBS: источник "${sourceName}" теперь ${visible ? 'показан' : 'скрыт'}`);
    } catch (err) {
        console.error(`❌ Ошибка изменения видимости источника ${sourceName}:`, err.message);
    }
}

async function refreshBrowserSource(sourceName) {
    if (!isConnected) {
        console.log(`⚠️ OBS не подключен, пропускаем обновление браузера: ${sourceName}`);
        return;
    }

    try {
        await obs.call('PressInputPropertiesButton', {
            inputName: sourceName,
            propertyName: 'refreshnocache'
        });
        console.log(`🔄 Браузер обновлен: "${sourceName}"`);
    } catch (err) {
        console.error(`❌ Ошибка обновления браузера ${sourceName}:`, err.message);
    }
}

async function waitForOBSConnection(maxWaitMs = 10000) {
    const startTime = Date.now();
    while (!isConnected) {
        if (Date.now() - startTime > maxWaitMs) {
            console.warn('⚠️ Истек таймаут ожидания подключения к OBS');
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return true;
}

module.exports = {
    connectOBS,
    switchScene,
    playRewardMedia,
    setSourceVisibility,
    refreshBrowserSource,
    waitForOBSConnection
};