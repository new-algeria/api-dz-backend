const { fetchUri, fetchData, fetchMetadata } = require("../utils/fetchData");
const { convertFromJson } = require("../utils/converter");
const axios = require('axios');
const { sendEmail } = require('../utils/mailer');
const { handleDownload, generateLink } = require("../utils/downloadHandler");
const path = require('path');
const { scanMapDirectories } = require('../utils/directoryScanner');

// Helper function to remove sensitive fields
const removeSensitiveInfo = (obj) => {
  if (typeof obj !== "object" || obj === null) return obj;

  const newObj = Array.isArray(obj) ? [...obj] : { ...obj };

  // Remove sensitive fields from the root level
  delete newObj.link;
  delete newObj.path;
  delete newObj.website;

  // Remove sensitive fields from source object if it exists
  if (newObj.source && typeof newObj.source === "object") {
    delete newObj.source.link;
    delete newObj.source.path;
    delete newObj.source.website;
  }

  // Recursively clean nested objects and arrays
  if (Array.isArray(newObj)) {
    return newObj.map((item) => removeSensitiveInfo(item));
  }

  // Clean nested objects
  Object.keys(newObj).forEach((key) => {
    if (typeof newObj[key] === "object" && newObj[key] !== null) {
      newObj[key] = removeSensitiveInfo(newObj[key]);
    }
  });

  return newObj;
};

exports.getDataInfo = async (req, res) => {
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;
    const dataDescriptions = await fetchUri(dataDescriptionUrl);

    // Process each item to add dataFormat and remove sensitive info
    const processedData = dataDescriptions.map((item) => {
      // Determine data format
      let dataFormat = "json"; // default format for API endpoints
      if (item.path) {
        const extension = path.extname(item.path).toLowerCase();
        dataFormat = extension ? extension.substring(1) : "json";
      }

      // Clean sensitive information
      const cleanedItem = removeSensitiveInfo(item);

      // Return item with dataFormat
      return {
        dataFormat,
        ...cleanedItem,
      };
    });

    res.json(processedData);
  } catch (error) {
    console.error("Error fetching data info:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

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

    // Store the path/link temporarily for fetching
    const tempPath = item.path;
    const tempLink = item.link;

    // Define variables for data and metadata
    let data, metadata, sourceType;

    if (tempPath) {
      // Handle file from storage
      const unescapedPath = tempPath.replace(/\//g, "/");
      const dataUrl = `${baseUrl}${unescapedPath}`;
      [data, metadata] = await Promise.all([
        fetchData(dataUrl),
        fetchMetadata(dataUrl),
      ]);
    } else if (tempLink) {
      // Handle API endpoint
      data = await fetchUri(tempLink);
      metadata = {
        "last-modified": new Date().toUTCString(), // Current time as API data is real-time
        "content-type": "application/json",
      };
    } else {
      return res.status(400).json({ error: "Invalid data source configuration" });
    }

    // Generate preview
    let preview;
    if (data.type === 'FeatureCollection') {
      const startIndex = Math.max(0, data.features.length - 3);
      preview = {
        type: 'FeatureCollection',
        features: data.features.slice(startIndex)
      };
    } else {
      const startIndex = Array.isArray(data) ? Math.max(0, data.length - 3) : 0;
      preview = Array.isArray(data) ? data.slice(startIndex) : data;
    }

    // Clean sensitive information from item and preview
    const cleanedItem = removeSensitiveInfo(item);

    // Determine data format
    let dataFormat = "json"; // default format for API endpoints
    if (tempPath) {
      const extension = path.extname(tempPath).toLowerCase();
      dataFormat = extension ? extension.substring(1) : "json"; // remove the dot from extension
    }

    // Return structured response with cleaned data
    res.json({
      type: sourceType,
      dataFormat: dataFormat,
      'last-edited': new Date(metadata["last-modified"]),
      length: data.length,
      preview: preview,
      ...cleanedItem,
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


// Add new endpoint for sending emails
exports.sendNotification = async (req, res) => {
  try {
    console.log('Received notification request:', req.body); // Add debug log
    const { to, subject, content } = req.body;
    
    if (!to || !subject || !content) {
      console.log('Missing fields:', { to, subject, content }); // Add debug log
      return res.status(400).json({ 
        error: "Missing required fields",
        received: { to, subject, content } 
      });
    }
    
    const result = await sendEmail({
      to,
      subject,
      content
    });
    
    res.json({ message: "Email sent successfully", requestId: result.requestId });
  } catch (error) {
    console.error("Error in sendNotification:", error);
    res.status(500).json({ error: "Failed to send email" });
  }
};

// Download Section (generate link / token and download item )
exports.generateDownloadLink = generateLink;
exports.downloadFile = handleDownload;

exports.getMapsInfo = async (req, res) => {
  const baseUrl = process.env.CLOUD_STORAGE_URL;
  try {
    const directories = await scanMapDirectories(baseUrl);
    res.json({
      count: directories.length,
      maps: directories
    });
  } catch (error) {
    console.error("Error fetching maps info:", error.message);
    res.status(500).json({ error: "Failed to fetch maps information" });
  }
};

exports.getMapFile = async (req, res) => {
  const { folder, type } = req.params;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    const fileTypes = {
      description: 'json',
      map: 'html',
      preview: 'png'
    };

    const fileUrl = `${baseUrl}/spatial/maps/${folder}/${type}.${fileTypes[type]}`;
    
    // For preview and map, stream the response
    if (type === 'preview' || type === 'map') {
      const response = await axios.get(fileUrl, { responseType: 'stream' });
      res.setHeader('Content-Type', type === 'preview' ? 'image/png' : 'text/html');
      return response.data.pipe(res);
    }

    // For description (JSON)
    const data = await fetchUri(fileUrl);
    res.json(data);

  } catch (error) {
    console.error(`Error fetching map ${type}:`, error.message);
    res.status(404).json({ error: `Map ${type} not found` });
  }
};
