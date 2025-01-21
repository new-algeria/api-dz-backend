const axios = require('axios');

module.exports = async function fetchData(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch data from ${url}: ${error.message}`);
  }
};