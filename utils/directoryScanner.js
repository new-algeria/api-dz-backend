const axios = require('axios');
const cheerio = require('cheerio');

exports.scanMapDirectories = async (baseUrl) => {
    try {

        const response = await axios.get(`${baseUrl}/spatial/maps/`);
        const html = response.data;

        const $ = cheerio.load(html);

        const directories = [];
        $('pre a').each((index, element) => {
            const $element = $(element);
            const href = $element.attr('href');
            const $prev = $element.prev('img');
            if ($prev.attr('alt') === '[DIR]') {
                const dirName = href.replace(/\/$/, '');
                directories.push(dirName);
            }
        });

        console.log("Found directories:", directories);
        return directories;
    } catch (error) {
        throw new Error(`Failed to scan directories: ${error.message}`);
    }
};
