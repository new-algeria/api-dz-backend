const { fetchUri, fetchData } = require("./fetchData");
const { convertFromJson } = require("./converter");
const { generateDownloadToken, verifyDownloadToken } = require('./downloadToken');
const axios = require('axios');
const { createTokenMapping } = require('./tokenMapper');

async function handleDownload(req, res) {
    const { slug, format, token } = req.params;
    const baseUrl = process.env.CLOUD_STORAGE_URL;

    // Verify download token
    if (!token || !verifyDownloadToken(token, slug, format)) {
        return res.status(403).json({ error: "Invalid or expired download token" });
    }

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

        let data;
        if (item.link && item.link.trim()) {
            // Handle API endpoint
            data = await fetchUri(item.link);
        } else if (item.path) {
            // Handle file data
            const unescapedPath = item.path.replace(/\//g, "/");
            const dataUrl = `${baseUrl}${unescapedPath}`;
            const sourceFormat = dataUrl.split('.').pop().toLowerCase();
            data = await fetchData(dataUrl);
            // If source format is same as requested format and it's not an API
            if (sourceFormat === format) {
                const response = await axios.get(dataUrl, { responseType: 'stream' });
                res.setHeader('Content-Type', `application/${format}`);
                res.setHeader('Content-Disposition', `attachment; filename=${slug}.${format}`);
                return response.data.pipe(res);
            }
        } else {
            return res.status(400).json({ error: "Invalid data description" });
        }

        // Convert to requested format
        const converted = await convertFromJson(data, format);
        
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
        console.error("Error processing download:", error);
        res.status(500).json({ error: "Server error" });
    }
}

async function generateLink(req, res) {
  const { slug, format } = req.params;
  
  // Validate format
  const allowedFormats = ['csv', 'xlsx', 'json', 'geojson', 'xml'];
  if (!allowedFormats.includes(format)) {
    return res.status(400).json({ error: "Unsupported format" });
  }

  try {
    const downloadToken = generateDownloadToken(slug, format);
    const shortToken = createTokenMapping(slug, format, downloadToken);
    const downloadUrl = `${req.protocol}://${req.get('host')}/${shortToken}`;
    
    res.json({ downloadUrl });
  } catch (error) {
    console.error("Error generating download link:", error);
    res.status(500).json({ error: "Failed to generate download link" });
  }
}

module.exports = {
    handleDownload,
    generateLink
};