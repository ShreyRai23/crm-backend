'use strict';

const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

if (!GEMINI_API_KEY) {
  console.error('[Gemini] GEMINI_API_KEY is not set. AI features will be unavailable.');
}

/**
 * Singleton Gemini AI client.
 * Initialized with the API key from environment.
 */
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/**
 * Generates content using the configured Gemini model.
 *
 * @param {string} prompt - The full prompt string to send.
 * @param {object} [config={}] - Optional generation config (temperature, etc.)
 * @returns {Promise<string>} The text response from the model.
 */
const generateContent = async (prompt, config = {}) => {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      ...config,
    },
  });

  const text = response.text;
  if (!text && text !== '') {
    throw new Error('Gemini returned an empty response. The model may be unavailable.');
  }
  return text;
};

module.exports = { ai, generateContent, GEMINI_MODEL };
