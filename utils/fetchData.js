const axios = require("axios");
const { convertToJson } = require("./converter");

async function fetchUri(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch uri of ${url}: ${error.message}`);
  }
}

async function fetchData(url) {
  try {
    const fileType = url.split(".").pop().toLowerCase();

    let response;
    if (['csv', 'xlsx', 'xml'].includes(fileType)) {
      response = await axios.get(url, { responseType: 'arraybuffer' });
    } else {
      response = await axios.get(url); // JSON or GEOJSON
    }

    // Convert the data based on file type
    const jsonData = await convertToJson(response.data, fileType);
    return jsonData;
  } catch (error) {
    throw new Error(`Failed to fetch data from ${url}: ${error.message}`);
  }
}

module.exports = {
  fetchUri,
  fetchData
};