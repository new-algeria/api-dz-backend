const { fetchUri, fetchData, fetchMetadata } = require("../utils/fetchData");
const { convertFromJson, convertToJson } = require("../utils/converter");
const axios = require('axios');

exports.getDetails = async (req, res) => {
  const slug = req.params.slug;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    // URL of the datas_description.json file
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;

    // Fetch the datas_description.json file
    const dataDescriptions = await fetchUri(dataDescriptionUrl);

    // Find the item with the matching slug
    const item = dataDescriptions.find((desc) => desc.slug === slug);

    if (!item) {
      return res.status(404).json({ error: "Data not found" });
    }

    // Unescape the item.path
    const unescapedPath = item.path.replace(/\//g, "/");

    // Construct the URL to the JSON data file
    const dataUrl = `${baseUrl}${unescapedPath}`;

    // Fetch all required data in parallel
    const [data, metadata] = await Promise.all([
      fetchData(dataUrl),
      fetchMetadata(dataUrl)
    ]);

    // Generate preview using the same logic as getSampleItems
    let preview;
    if (data.type === 'FeatureCollection') {
      preview = {
        type: 'FeatureCollection',
        features: data.features.slice(0, 3)
      };
    } else {
      preview = Array.isArray(data) ? data.slice(0, 3) : data;
    }

    // Return structured response
    res.json({
      'last-edited': new Date(metadata["last-modified"]),
      'length': data.length,
      preview,
      data
    });

  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getRandomItems = async (req, res) => {
  const slug = req.params.slug;
  const count = req.params.count ? parseInt(req.params.count) : 3;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  // Validate count parameter if provided
  if (isNaN(count) || count < 1) {
    return res.status(400).json({ error: "Count must be a positive number" });
  }

  try {
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;
    const dataDescriptions = await fetchUri(dataDescriptionUrl);
    const item = dataDescriptions.find((desc) => desc.slug === slug);

    if (!item) {
      return res.status(404).json({ error: "Data not found" });
    }

    const unescapedPath = item.path.replace(/\//g, "/");
    const dataUrl = `${baseUrl}${unescapedPath}`;
    const data = await fetchData(dataUrl);

    // Handle GeoJSON FeatureCollection
    if (data.type === 'FeatureCollection') {
      const features = data.features;
      const itemCount = Math.min(count, features.length);
      const randomFeatures = features.sort(() => 0.5 - Math.random()).slice(0, itemCount);
      
      res.json({
        type: 'FeatureCollection',
        features: randomFeatures
      });
    } else {
      // Handle regular JSON arrays
      const itemCount = Math.min(count, data.length);
      const randomItems = data.sort(() => 0.5 - Math.random()).slice(0, itemCount);
      res.json(randomItems);
    }
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getSampleItems = async (req, res) => {
  const slug = req.params.slug;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;
    const dataDescriptions = await fetchUri(dataDescriptionUrl);
    const item = dataDescriptions.find((desc) => desc.slug === slug);

    if (!item) {
      return res.status(404).json({ error: "Data not found" });
    }

    const unescapedPath = item.path.replace(/\//g, "/");
    const dataUrl = `${baseUrl}${unescapedPath}`;
    const data = await fetchData(dataUrl);

    // Handle GeoJSON FeatureCollection
    if (data.type === 'FeatureCollection') {
      const sampleFeatures = data.features.slice(0, 3);
      res.json({
        type: 'FeatureCollection',
        features: sampleFeatures
      });
    } else {
      // Handle regular JSON arrays
      const sampleItems = data.slice(0, 3);
      res.json(sampleItems);
    }
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

exports.downloadFile = async (req, res) => {
  const { slug, format } = req.params;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  // Validate format
  const allowedFormats = ['csv', 'xlsx', 'json', 'geojson', 'xml'];
  if (!allowedFormats.includes(format)) {
    return res.status(400).json({ error: "Unsupported format" });
  }

  try {
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;
    const dataDescriptions = await fetchUri(dataDescriptionUrl);
    const item = dataDescriptions.find((desc) => desc.slug === slug);

    if (!item) {
      return res.status(404).json({ error: "Data not found" });
    }

    const unescapedPath = item.path.replace(/\//g, "/");
    const dataUrl = `${baseUrl}${unescapedPath}`;
    const sourceFormat = dataUrl.split('.').pop().toLowerCase();
    const data = await fetchData(dataUrl);

    // If source format is same as requested format, stream the file directly
    if (sourceFormat === format) {
      const response = await axios.get(dataUrl, { responseType: 'stream' });
      res.setHeader('Content-Type', `application/${format}`);
      res.setHeader('Content-Disposition', `attachment; filename=${slug}.${format}`);
      return response.data.pipe(res);
    }

    // Convert to json before converting to requested format
    const jsonData = await convertToJson(data, sourceFormat);
    console.log(jsonData.isArray ? jsonData[0] : jsonData);
    const converted = await convertFromJson(jsonData, format);
    
    // Set appropriate headers
    const contentTypes = {
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      json: 'application/json',
      geojson: 'application/geo+json',
      xml: 'application/xml'
    };

    res.setHeader('Content-Type', contentTypes[format]);
    res.setHeader('Content-Disposition', `attachment; filename=${slug}.${format}`);
    res.send(converted);

  } catch (error) {
    console.error("Error processing download:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};
