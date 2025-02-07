const axios = require('axios');

async function scanMapDirectories(baseUrl) {
  try {
    // Make request to list contents of maps directory
    const mapsUrl = `${baseUrl}/spatial/maps/`;
    const response = await axios.get(mapsUrl, { 
      headers: { 'Accept': 'application/json' }
    });

    // Extract directory names from response
    // This will depend on how your cloud storage lists directories
    // Assuming response lists directories in a standard format
    const directories = response.data
      .filter(item => item.type === 'directory')
      .map(dir => ({
        name: dir.name,
        path: `/spatial/maps/${dir.name}`
      }));

    return directories;
  } catch (error) {
    console.error('Error scanning directories:', error);
    throw new Error('Failed to scan map directories');
  }
}

module.exports = { scanMapDirectories };
