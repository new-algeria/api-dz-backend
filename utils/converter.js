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

async function convertFromJson(data, targetFormat) {
  switch (targetFormat) {
    case "csv":
      const csvData = Array.isArray(data) ? data : [data];
      const header = Object.keys(csvData[0]);
      const csvRows = [header.join(",")];
      csvData.forEach((row) => {
        csvRows.push(header.map((field) => row[field]).join(","));
      });
      return csvRows.join("\n");

    case "xlsx":
      const ws = xlsx.utils.json_to_sheet(Array.isArray(data) ? data : [data]);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
      return xlsx.write(wb, { type: "buffer" });

    case "xml":
      const builder = new xml2js.Builder();
      return builder.buildObject({
        root: Array.isArray(data) ? { item: data } : data,
      });

    case "json":
    case "geojson":
      return JSON.stringify(data, null, 2);

    default:
      throw new Error(`Unsupported target format: ${targetFormat}`);
  }
}

module.exports = {
  convertToJson,
  convertFromJson,
};
