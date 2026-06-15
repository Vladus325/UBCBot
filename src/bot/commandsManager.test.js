const fs = require('fs');
const path = require('path');
const {
  processText,
  processRollCommand,
  processBotAnswerCommand,
  getRandomCompliment
} = require('./commandsManager');

describe('commandsManager', () => {
  let randomSpy;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });
  describe('processText', () => {
    it('replaces basic placeholders and command values', async () => {
      const tags = { username: 'user1', 'display-name': 'UserOne', badges: {} };
      const channel = '#channel1';
      const result = await processText('Привет {user} на канале {channel} {displayName}', tags, channel, []);
      expect(result).toBe('Привет user1 на канале channel1 UserOne');
    });

    it('handles roll placeholders for d20 and d100', async () => {
      const tags = { username: 'user1', badges: {} };
      const channel = '#channel1';
      const output = await processText('{roll:20} {roll:100}', tags, channel, []);
      expect(output).toMatch(/user1 бросает к20: \d+/);
      expect(output).toMatch(/user1 бросает к100: \d+/);
    });

    it('returns an empty replacement for unknown placeholder commands', async () => {
      const tags = { username: 'user1', badges: {} };
      const channel = '#channel1';
      const result = await processText('Всё ок {unknown:5}', tags, channel, []);
      expect(result).toBe('Всё ок ');
    });
  });

  describe('processRollCommand', () => {
    it('returns a roll result for default 6-sided die', () => {
      const tags = { username: 'user1', badges: {} };
      const result = processRollCommand(null, tags);
      expect(result).toMatch(/user1 бросает к6: \d+/);
    });

    it('returns a roll result for d20', () => {
      const tags = { username: 'user1', badges: {} };
      const result = processRollCommand('20', tags);
      expect(result).toMatch(/user1 бросает к20: \d+/);
    });

    it('returns a roll result for d100', () => {
      const tags = { username: 'user1', badges: {} };
      const result = processRollCommand('100', tags);
      expect(result).toMatch(/user1 бросает к100: \d+/);
    });
  });

  describe('processBotAnswerCommand', () => {
    it('returns a prompt when args are empty', async () => {
      const tags = { username: 'user1', badges: {} };
      const result = await processBotAnswerCommand([], tags);
      expect(result).toMatch(/user1, /);
    });

    it('rejects forbidden content', async () => {
      const tags = { username: 'user1', badges: {} };
      const result = await processBotAnswerCommand(['timeout'], tags);
      expect(result).toBe('user1, извини, но я не могу помогать с такими вещами 😅');
    });
  });

  describe('getRandomCompliment', () => {
    it('returns one of the compliments from config', () => {
      const compliment = getRandomCompliment();
      expect(typeof compliment).toBe('string');
      expect(compliment.length).toBeGreaterThan(0);
    });
  });
});
