const https = require('https');
const htmlparser = require('htmlparser');
const AWS = require('aws-sdk');

const SUG_URL = process.env.PAGE_URL;
const TIMESLOTS_TABLE_NAME = process.env.TIMESLOTS_TABLE_NAME;
const NOTIFICATION_TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN;
const DATE_REGEX = /\d{2}\/\d{2}\/\d{4}.*$/;
const TIME_REGEX = /\d+:\d{2}.*$/;

const dynamodb = new AWS.DynamoDB();
const sns = new AWS.SNS();

function fetchContentPromise() {
  return new Promise((resolve, reject) => {
    let content = '';
    https.get(SUG_URL, (res) => {
      console.log(`statusCode: ${res.statusCode}`);
      res.on('data', (d) => {
        content += d;
      });
      res.on('end', () => {
        resolve(content);
      });
    }).on('error', (e) => {
      reject(e);
    });
  });
}

function parseHtmlPromise(content) {
  return new Promise((resolve, reject) => {
    const handler = new htmlparser.DefaultHandler((err, dom) => {
      if (err) reject(err);
      else resolve(dom);
    }, { verbose: false });
    const parser = new htmlparser.Parser(handler);
    parser.parseComplete(content);
  });
}


exports.handler = (event, context, callback) => {

  let slots = [];
  let newTimeslots = [];
  fetchContentPromise().then((content) => {
    console.log(`Content length: ${content.length}`);
    return parseHtmlPromise(content);
  }).then((dom) => {
    console.log(`Successfully parsed`);
    const elementsByClass = htmlparser.DomUtils.getElements({
      class: 'SUGtableouter'
    }, dom);

    console.log(elementsByClass);

    const textElements = htmlparser.DomUtils.getElementsByTagType('text', dom);
    console.log(`${textElements.length} text elements`);
    var lastDate = undefined;
    for (var i = 0; i < textElements.length; i++) {
      const textData = textElements[i].data;
      const dateFound = textData.match(DATE_REGEX);
      if (dateFound) {
        console.log(`Date at ${i}: ${dateFound[0]}`);
        lastDate = dateFound[0].trim();
      }
      const timeFound = textData.match(TIME_REGEX);
      if (timeFound) {
        console.log(`Time at ${i}: ${timeFound[0]}`);
        const dateTime = [lastDate, timeFound[0].replace('&nbsp;', '').trim()].join('-');
        if ((slots.length == 0) || (dateTime != slots[slots.length - 1])) {
          slots.push(dateTime);
        } else {
          console.log(`Dup timeslot found: ${dateTime}`);
        }
      }
    }
    slots.sort();

    const dynamodbRequestKeys = slots.map((timeslot) => {
      return {
        Timeslot: {
          S: timeslot
        }
      };
    });
    const batchGetItemParams = {
      RequestItems: {}
    };
    batchGetItemParams.RequestItems[TIMESLOTS_TABLE_NAME] = {
      Keys: dynamodbRequestKeys
    };
    console.log(`DynamoDB request for ${dynamodbRequestKeys.length} keys`);
    return dynamodb.batchGetItem(batchGetItemParams).promise();

  }).then((data) => {

    const returnedKeys = data.Responses[TIMESLOTS_TABLE_NAME];
    const unprocessed = data.UnprocessedKeys[TIMESLOTS_TABLE_NAME];
    console.log(`DynamoDB response: ${returnedKeys.length}`);
    if (unprocessed) {
      console.warn(`DynamoDB unprocessed: ${JSON.stringify(unprocessed, null, 2)}`);
    }

    const existingTimeslots = returnedKeys.map((returnedKey) => {
      return returnedKey.Timeslot.S;
    }).sort();
    console.log(`Existing timeslots (${existingTimeslots.length}): ${JSON.stringify(existingTimeslots)}`);

    newTimeslots = slots.filter(slot => !(existingTimeslots.includes(slot)));
    console.log(`New timeslots (${newTimeslots.length}: ${JSON.stringify(newTimeslots)})`);

    // Publish an SNS if needed
    if (newTimeslots.length > 0) {
      return sns.publish({
        TopicArn: NOTIFICATION_TOPIC_ARN,
        Subject: 'New slots',
        Message: `${SUG_URL}: New slots are ${newTimeslots.join(',')}`
      }).promise();
    } else {
      return Promise.resolve(null);
    }

  }).then((data) => {

    if (data) {
      console.log(`SNS.Publish done`);
    }

    if (newTimeslots.length > 0) {
      const putRequests = newTimeslots.map((timeslot) => {
        return {
          PutRequest: {
            Item: {
              Timeslot: {
                S: timeslot
              }
            }
          }
        };
      });

      // Chop up into requests of 25
      const batchWriteItemChoppedRequests = [];
      for (var i = 0; i < (putRequests.length / 25); i++) {
        const params = {
          RequestItems: {}
        };
        params.RequestItems[TIMESLOTS_TABLE_NAME] = putRequests.slice(i * 25, (i + 1) * 25);
        batchWriteItemChoppedRequests.push(params);
        console.log(`batchWriteItem request ${i}: ${params.RequestItems[TIMESLOTS_TABLE_NAME].length} items to put`);
      }
      const batchWriteItemPromises = batchWriteItemChoppedRequests.map((params) => {
        return dynamodb.batchWriteItem(params).promise();
      });
      return Promise.all(batchWriteItemPromises);

    } else {
      return Promise.resolve(null);
    }

  }).then((data) => {

    if (newTimeslots.length > 0) {
      console.log(`DynamoDB batchWriteItem complete for ${newTimeslots.length} slots`);
    }

    callback(null, {
      statusCode: 200,
      body: JSON.stringify({slots})
    });

  }).catch((e) => {
    console.log(`error ${e}`);
    callback(null, {
      statusCode: 200,
      body: JSON.stringify({error: e})
    });
  });
};
