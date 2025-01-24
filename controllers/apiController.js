const { fetchUri, fetchData } = require("../utils/fetchData");

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

    // Fetch the JSON data file
    const data = await fetchData(dataUrl);

    // Return the data
    res.json(data);
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
