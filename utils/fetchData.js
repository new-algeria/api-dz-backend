const axios = require("axios");
const { convertToJson } = require("./converter");

module.exports = async function fetchData(url) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    const fileType = url.split(".").pop().toLowerCase();

    // Convert the data based on file type
    const jsonData = await convertToJson(response.data, fileType);
    return jsonData;
  } catch (error) {
    throw new Error(`Failed to fetch data from ${url}: ${error.message}`);
  }
};
