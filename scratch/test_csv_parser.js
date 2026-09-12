function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let insideQuote = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (insideQuote) {
      if (char === '"') {
        if (nextChar === '"') {
          currentVal += '"';
          i++;
        } else {
          insideQuote = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        insideQuote = true;
      } else if (char === ',') {
        currentRow.push(currentVal.trim());
        currentVal = '';
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        currentRow.push(currentVal.trim());
        currentVal = '';
        if (currentRow.some(val => val !== '')) rows.push(currentRow);
        currentRow = [];
      } else if (char === '\n') {
        currentRow.push(currentVal.trim());
        currentVal = '';
        if (currentRow.some(val => val !== '')) rows.push(currentRow);
        currentRow = [];
      } else {
        currentVal += char;
      }
    }
  }
  if (currentVal || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    if (currentRow.some(val => val !== '')) rows.push(currentRow);
  }
  return rows;
}

const sample = 'name,usn,sem,sec,dept,email\r\n  "Kumar, Rahul"  , 1CD23CS001 , 5 , A , CSE , rahul@example.com\r\n\r\n"Priya Sharma",1CD23CS002,5,B,CSE,priya@example.com\n';
const parsed = parseCSV(sample);
console.log('Parsed rows:', parsed.length);
console.log(parsed);

if (parsed.length === 3 && parsed[1][0] === 'Kumar, Rahul' && parsed[1][1] === '1CD23CS001') {
  console.log('CSV Parser Test Passed!');
} else {
  console.error('CSV Parser Test Failed!');
  process.exit(1);
}
