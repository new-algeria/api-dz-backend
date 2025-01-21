const fetchData = require("../utils/fetchData");

exports.getDetails = async (req, res) => {
  const slug = req.params.slug;
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    // URL of the datas_description.json file
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;

    // Fetch the datas_description.json file
    const dataDescriptions = await fetchData(dataDescriptionUrl);

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
  const baseUrl = process.env.CLOUD_STORAGE_URL;

  try {
    const dataDescriptionUrl = `${baseUrl}/datas_description.json`;
    const dataDescriptions = await fetchData(dataDescriptionUrl);
    const item = dataDescriptions.find((desc) => desc.slug === slug);

    if (!item) {
      return res.status(404).json({ error: "Data not found" });
    }

    const unescapedPath = item.path.replace(/\//g, "/");
    const dataUrl = `${baseUrl}${unescapedPath}`;
    const data = await fetchData(dataUrl);

    // Shuffle and select 3 random items
    const randomItems = data.sort(() => 0.5 - Math.random()).slice(0, 3);
    res.json(randomItems);
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};
