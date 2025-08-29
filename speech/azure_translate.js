// Azure Translator helper
const axios = require('axios');

const EP = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
const API = `${EP}/translate?api-version=3.0`;

/**
 * Translate text using Azure Translator
 * @param {string} text
 * @param {string} fromLang
 * @param {string} toLang
 * @returns {Promise<{text:string}>}
 */
async function translateText(text, fromLang, toLang) {
  if (!process.env.AZURE_TRANSLATOR_KEY || !process.env.AZURE_TRANSLATOR_REGION) {
    throw new Error('Azure Translator credentials missing');
  }
  if (!text || !text.trim()) return { text: '' };

  const url = `${API}&from=${encodeURIComponent(fromLang)}&to=${encodeURIComponent(toLang)}`;
  const headers = {
    'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
    'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
    'Content-Type': 'application/json'
  };
  const body = [{ Text: text }];

  const { data } = await axios.post(url, body, { headers });
  const out = data?.[0]?.translations?.[0]?.text || '';
  return { text: out };
}

module.exports = { translateText };
