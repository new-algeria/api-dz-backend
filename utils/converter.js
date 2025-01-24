const xlsx = require('xlsx');
const csv = require('csv-parse/sync');
const xml2js = require('xml2js');

async function convertToJson(data, fileType) {
  switch (fileType) {
    case 'csv':
      return csv.parse(data, { columns: true });
    
    case 'xlsx':
      const workbook = xlsx.read(data, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      return xlsx.utils.sheet_to_json(firstSheet);
    
    case 'xml':
      const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
      return parser.parseStringPromise(data);
    
    case 'geojson':
    case 'json':
      return typeof data === 'string' ? JSON.parse(data) : data;
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

module.exports = { convertToJson };
