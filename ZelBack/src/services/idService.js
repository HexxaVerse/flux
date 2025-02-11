const config = require('config');
const bitcoinMessage = require('bitcoinjs-message');
const qs = require('qs');
const os = require('os');

const userconfig = require('../../../config/userconfig');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const generalService = require('./generalService');
const dockerService = require('./dockerService');
const fluxCommunication = require('./fluxCommunication');

const goodchars = /^[1-9a-km-zA-HJ-NP-Z]+$/;

async function confirmNodeTierHardware() {
  try {
    const tier = await generalService.nodeTier().catch((error) => {
      log.error(error);
    });
    const nodeRam = os.totalmem() / 1024 / 1024 / 1024;
    const nodeCpuCores = os.cpus().length;
    log.info(`Node Tier: ${tier}`);
    log.info(`Node Total Ram: ${nodeRam}`);
    log.info(`Node Cpu Cores: ${nodeCpuCores}`);
    if (tier === 'bamf') {
      if (nodeRam < 31) {
        throw new Error(`Node Total Ram (${nodeRam}) below Stratus requirements`);
      }
      if (nodeCpuCores < 8) {
        throw new Error(`Node Cpu Cores (${nodeCpuCores}) below Stratus requirements`);
      }
    } else if (tier === 'super') {
      if (nodeRam < 7) {
        throw new Error(`Node Total Ram (${nodeRam}) below Nimbus requirements`);
      }
      if (nodeCpuCores < 4) {
        throw new Error(`Node Cpu Cores (${nodeCpuCores}) below Nimbus requirements`);
      }
    } else if (tier === 'basic') {
      if (nodeRam < 3) {
        throw new Error(`Node Total Ram (${nodeRam}) below Cumulus requirements`);
      }
      if (nodeCpuCores < 2) {
        throw new Error(`Node Cpu Cores (${nodeCpuCores}) below Cumulus requirements`);
      }
    }
    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

async function loginPhrase(req, res) {
  try {
    // check docker availablility
    await dockerService.dockerListContainers(false);
    // check Node Hardware Requirements are ok.
    const hwPassed = await confirmNodeTierHardware();
    if (hwPassed === false) {
      throw new Error('Node hardware requirements not met');
    }
    // check DOS state (contains daemon checks)
    const dosState = await fluxCommunication.getDOSState();
    if (dosState.status === 'error') {
      const errorMessage = 'Unable to check DOS state';
      const errMessage = serviceHelper.createErrorMessage(errorMessage);
      res.json(errMessage);
      return;
    }
    if (dosState.status === 'success') {
      if (dosState.data.dosState > 10 || dosState.data.dosMessage !== null || dosState.data.nodeHardwareSpecsGood === false) {
        let errMessage = serviceHelper.createErrorMessage(dosState.data.dosMessage, 'DOS', dosState.data.dosState);
        if (dosState.data.dosMessage !== 'Flux IP detection failed' && dosState.data.dosMessage !== 'Flux collision detection') {
          errMessage = serviceHelper.createErrorMessage(dosState.data.dosMessage, 'CONNERROR', dosState.data.dosState);
        }
        if (dosState.data.nodeHardwareSpecsGood === false) {
          errMessage = serviceHelper.createErrorMessage('Minimum hardware required for FluxNode tier not met', 'DOS', 100);
        }
        res.json(errMessage);
        return;
      }
    }

    const timestamp = new Date().getTime();
    const validTill = timestamp + (15 * 60 * 1000); // 15 minutes
    const phrase = timestamp + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    /* const activeLoginPhrases = [
       {
         loginPhrase: 1565356121335e9obp7h17bykbbvub0ts488wnnmd12fe1pq88mq0v,
         createdAt: 2019-08-09T13:08:41.335Z,
         expireAt: 2019-08-09T13:23:41.335Z
       }
    ] */
    const db = serviceHelper.databaseConnection();
    const database = db.db(config.database.local.database);
    const collection = config.database.local.collections.activeLoginPhrases;
    const newLoginPhrase = {
      loginPhrase: phrase,
      createdAt: new Date(timestamp),
      expireAt: new Date(validTill),
    };
    const value = newLoginPhrase;
    await serviceHelper.insertOneToDatabase(database, collection, value);
    // all is ok
    const phraseResponse = serviceHelper.createDataMessage(phrase);
    res.json(phraseResponse);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

// loginPhrase without status checks
async function emergencyPhrase(req, res) {
  try {
    const timestamp = new Date().getTime();
    const validTill = timestamp + (15 * 60 * 1000); // 15 minutes
    const phrase = timestamp + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    const db = serviceHelper.databaseConnection();
    const database = db.db(config.database.local.database);
    const collection = config.database.local.collections.activeLoginPhrases;
    const newLoginPhrase = {
      loginPhrase: phrase,
      createdAt: new Date(timestamp),
      expireAt: new Date(validTill),
    };
    const value = newLoginPhrase;
    await serviceHelper.insertOneToDatabase(database, collection, value);
    const phraseResponse = serviceHelper.createDataMessage(phrase);
    res.json(phraseResponse);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function verifyLogin(req, res) {
  // Phase 2 - check that request is valid
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(body);
      const address = processedBody.zelid || processedBody.address;
      const { signature } = processedBody;
      const message = processedBody.loginPhrase || processedBody.message;
      const timestamp = new Date().getTime();

      // First check that this message is valid - for example, it does not have an old timestamp, it is at least 40 chars and was generated by us (as in it is stored in our db)
      if (address === undefined || address === '') {
        throw new Error('No ZelID is specified');
      }

      if (!goodchars.test(address)) {
        throw new Error('ZelID is not valid');
      }

      if (address[0] !== '1') {
        throw new Error('ZelID is not valid');
      }

      if (address.length > 34 || address.length < 25) {
        throw new Error('ZelID is not valid');
      }

      if (message === undefined || message === '') {
        throw new Error('No message is specified');
      }

      if (message.length < 40) {
        throw new Error('Signed message is not valid');
      }

      if (message.substring(0, 13) < (timestamp - 900000) || message.substring(0, 13) > timestamp) {
        throw new Error('Signed message is not valid');
      }

      if (signature === undefined || signature === '') {
        throw new Error('No signature is specified');
      }
      // Basic checks passed. First check if message is in our activeLoginPhrases collection

      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.activeLoginPhrases;
      const query = { loginPhrase: message };
      const projection = {};
      const result = await serviceHelper.findOneInDatabase(database, collection, query, projection);

      if (result) {
        // It is present in our database
        if (result.loginPhrase.substring(0, 13) < timestamp) {
          // Second verify that this address signed this message
          let valid = false;
          try {
            valid = bitcoinMessage.verify(message, address, signature);
          } catch (error) {
            throw new Error('Invalid signature');
          }
          if (valid) {
            // Third associate that address, signature and message with our database
            // TODO signature hijacking? What if middleware guy knows all of this?
            // TODO do we want to have some timelimited logins? not needed now
            // Do we want to store sighash too? Nope we are verifying if provided signature is ok. In localStorage we are storing zelid, message, signature
            // const sighash = crypto
            //   .createHash('sha256')
            //   .update(signature)
            //   .digest('hex')
            const newLogin = {
              zelid: address,
              loginPhrase: message,
              signature,
            };
            let privilage = 'user';
            if (address === config.fluxTeamZelId) {
              privilage = 'fluxteam';
            } else if (address === userconfig.initial.zelid) {
              privilage = 'admin';
            }
            const loggedUsersCollection = config.database.local.collections.loggedUsers;
            const value = newLogin;
            await serviceHelper.insertOneToDatabase(database, loggedUsersCollection, value);
            const resData = {
              message: 'Successfully logged in',
              zelid: address,
              loginPhrase: message,
              signature,
              privilage,
            };
            const resMessage = serviceHelper.createDataMessage(resData);
            res.json(resMessage);
            serviceHelper.deleteLoginPhrase(message); // delete so it cannot be used again
          } else {
            throw new Error('Invalid signature');
          }
        } else {
          throw new Error('Signed message is no longer valid. Please request a new one.');
        }
      } else {
        throw new Error('Signed message is no longer valid. Please request a new one.');
      }
    } catch (error) {
      log.error(error);
      const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
      res.json(errMessage);
    }
  });
}

async function provideSign(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(body);
      const address = processedBody.zelid || processedBody.address;
      const { signature } = processedBody;
      const message = processedBody.loginPhrase || processedBody.message;

      if (address === undefined || address === '') {
        throw new Error('No ZelID is specified');
      }

      if (!goodchars.test(address)) {
        throw new Error('ZelID is not valid');
      }

      if (address[0] !== '1') {
        throw new Error('ZelID is not valid');
      }

      if (address.length > 34 || address.length < 25) {
        throw new Error('ZelID is not valid');
      }

      if (message === undefined || message === '') {
        throw new Error('No message is specified');
      }

      if (message.length < 40) {
        throw new Error('Signed message is not valid');
      }

      if (signature === undefined || signature === '') {
        throw new Error('No signature is specified');
      }
      const timestamp = new Date().getTime();
      const validTill = timestamp + (15 * 60 * 1000); // 15 minutes
      const identifier = address + message.substr(message.length - 13);

      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.activeSignatures;
      const newSignature = {
        signature,
        identifier,
        createdAt: new Date(timestamp),
        expireAt: new Date(validTill),
      };
      const value = newSignature;
      await serviceHelper.insertOneToDatabase(database, collection, value);
      // all is ok
      const phraseResponse = serviceHelper.createDataMessage(newSignature);
      res.json(phraseResponse);
    } catch (error) {
      log.error(error);
      const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
      res.json(errMessage);
    }
  });
}

async function activeLoginPhrases(req, res) {
  try {
    const authorized = await serviceHelper.verifyAdminSession(req.headers);
    if (authorized === true) {
      const db = serviceHelper.databaseConnection();

      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.activeLoginPhrases;
      const query = {};
      const projection = {
        projection: {
          _id: 0, loginPhrase: 1, createdAt: 1, expireAt: 1,
        },
      };
      const results = await serviceHelper.findInDatabase(database, collection, query, projection);
      const resultsResponse = serviceHelper.createDataMessage(results);
      res.json(resultsResponse);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function loggedUsers(req, res) {
  try {
    const authorized = await serviceHelper.verifyAdminSession(req.headers);
    if (authorized === true) {
      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.loggedUsers;
      const query = {};
      const projection = { projection: { _id: 0, zelid: 1, loginPhrase: 1 } };
      const results = await serviceHelper.findInDatabase(database, collection, query, projection);
      const resultsResponse = serviceHelper.createDataMessage(results);
      res.json(resultsResponse);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function loggedSessions(req, res) {
  try {
    const authorized = await serviceHelper.verifyUserSession(req.headers);
    if (authorized === true) {
      const db = serviceHelper.databaseConnection();

      const auth = serviceHelper.ensureObject(req.headers.zelidauth);
      const queryZelID = auth.zelid;
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.loggedUsers;
      const query = { zelid: queryZelID };
      const projection = { projection: { _id: 0, zelid: 1, loginPhrase: 1 } };
      const results = await serviceHelper.findInDatabase(database, collection, query, projection);
      const resultsResponse = serviceHelper.createDataMessage(results);
      res.json(resultsResponse);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function logoutCurrentSession(req, res) {
  try {
    const authorized = await serviceHelper.verifyUserSession(req.headers);
    if (authorized === true) {
      const auth = serviceHelper.ensureObject(req.headers.zelidauth);
      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.loggedUsers;
      const query = { $and: [{ signature: auth.signature }, { zelid: auth.zelid }] };
      const projection = {};
      await serviceHelper.findOneAndDeleteInDatabase(database, collection, query, projection);
      // console.log(results)
      const message = serviceHelper.createSuccessMessage('Successfully logged out');
      res.json(message);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function logoutSpecificSession(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await serviceHelper.verifyUserSession(req.headers);
      if (authorized === true) {
        const processedBody = serviceHelper.ensureObject(body);
        const obtainedLoginPhrase = processedBody.loginPhrase;
        const db = serviceHelper.databaseConnection();
        const database = db.db(config.database.local.database);
        const collection = config.database.local.collections.loggedUsers;
        const query = { loginPhrase: obtainedLoginPhrase };
        const projection = {};
        const result = await serviceHelper.findOneAndDeleteInDatabase(database, collection, query, projection);
        if (result.value === null) {
          const message = serviceHelper.createWarningMessage('Specified user was already logged out');
          res.json(message);
        }
        const message = serviceHelper.createSuccessMessage('Session successfully logged out');
        res.json(message);
      } else {
        const errMessage = serviceHelper.errUnauthorizedMessage();
        res.json(errMessage);
      }
    } catch (error) {
      log.error(error);
      const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
      res.json(errMessage);
    }
  });
}

async function logoutAllSessions(req, res) {
  try {
    const authorized = await serviceHelper.verifyUserSession(req.headers);
    if (authorized === true) {
      const auth = serviceHelper.ensureObject(req.headers.zelidauth);
      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.loggedUsers;
      const query = { zelid: auth.zelid };
      await serviceHelper.removeDocumentsFromCollection(database, collection, query);
      // console.log(result)
      const message = serviceHelper.createSuccessMessage('Successfully logged out all sessions');
      res.json(message);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function logoutAllUsers(req, res) {
  try {
    const authorized = await serviceHelper.verifyAdminSession(req.headers);
    if (authorized === true) {
      const db = serviceHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const collection = config.database.local.collections.loggedUsers;
      const query = {};
      await serviceHelper.removeDocumentsFromCollection(database, collection, query);
      const message = serviceHelper.createSuccessMessage('Successfully logged out all users');
      res.json(message);
    } else {
      const errMessage = serviceHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function wsRespondLoginPhrase(ws, req) {
  const { loginphrase } = req.params;
  // console.log(loginphrase)
  // respond with object containing address and signature to received message
  let connclosed = false;
  // eslint-disable-next-line no-param-reassign
  ws.onclose = (evt) => {
    console.log(evt.code);
    connclosed = true;
  };
  // eslint-disable-next-line no-param-reassign
  ws.onerror = (evt) => {
    log.error(evt.code);
    connclosed = true;
  };

  const db = serviceHelper.databaseConnection();

  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { loginPhrase: loginphrase };
  const projection = {};
  // eslint-disable-next-line no-inner-declarations
  async function searchDatabase() {
    try {
      const result = await serviceHelper.findOneInDatabase(database, collection, query, projection).catch((error) => {
        const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
        ws.send(qs.stringify(errMessage));
        ws.close(1011);
        throw error;
      });

      if (result) {
        // user is logged, all ok
        let privilage = 'user';
        if (result.zelid === config.fluxTeamZelId) {
          privilage = 'fluxteam';
        } else if (result.zelid === userconfig.initial.zelid) {
          privilage = 'admin';
        }
        const resData = {
          message: 'Successfully logged in',
          zelid: result.zelid,
          loginPhrase: result.loginPhrase,
          signature: result.signature,
          privilage,
        };
        const message = serviceHelper.createDataMessage(resData);
        if (!connclosed) {
          try {
            ws.send(qs.stringify(message));
            ws.close(1000);
          } catch (e) {
            log.error(e);
          }
        }
      } else {
        // check if this loginPhrase is still active. If so rerun this searching process
        const activeLoginPhrasesCollection = config.database.local.collections.activeLoginPhrases;
        const resultB = await serviceHelper.findOneInDatabase(database, activeLoginPhrasesCollection, query, projection).catch((error) => {
          const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
          ws.send(qs.stringify(errMessage));
          ws.close(1011);
          throw error;
        });
        if (resultB) {
          setTimeout(() => {
            if (!connclosed) {
              searchDatabase();
            }
          }, 500);
        } else {
          const errMessage = serviceHelper.createErrorMessage('Signed message is no longer valid. Please request a new one.');
          if (!connclosed) {
            try {
              ws.send(qs.stringify(errMessage));
              ws.close();
            } catch (e) {
              log.error(e);
            }
          }
        }
      }
    } catch (error) {
      log.error(error);
    }
  }
  searchDatabase();
}

async function wsRespondSignature(ws, req) {
  const { message } = req.params;
  console.log(message);

  let connclosed = false;
  // eslint-disable-next-line no-param-reassign
  ws.onclose = (evt) => {
    console.log(evt.code);
    connclosed = true;
  };
  // eslint-disable-next-line no-param-reassign
  ws.onerror = (evt) => {
    log.error(evt.code);
    connclosed = true;
  };

  const db = serviceHelper.databaseConnection();

  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.activeSignatures;
  const query = { identifier: message };
  const projection = {};
  async function searchDatabase() {
    try {
      const result = await serviceHelper.findOneInDatabase(database, collection, query, projection).catch((error) => {
        const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
        ws.send(qs.stringify(errMessage));
        ws.close(1011);
        throw error;
      });

      if (result) {
        // signature exists
        const response = serviceHelper.createDataMessage(result);
        if (!connclosed) {
          try {
            ws.send(qs.stringify(response));
            ws.close(1000);
          } catch (e) {
            log.error(e);
          }
        }
      } else {
        setTimeout(() => {
          if (!connclosed) {
            searchDatabase();
          }
        }, 500);
      }
    } catch (error) {
      log.error(error);
    }
  }
  searchDatabase();
}

async function checkLoggedUser(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(body);
      const { zelid } = processedBody;
      const { signature } = processedBody;
      if (!zelid) {
        throw new Error('No user ZelID specificed');
      }
      if (!signature) {
        throw new Error('No user ZelID signature specificed');
      }
      const headers = {
        zelidauth: {
          zelid,
          signature,
        },
      };
      const isAdmin = await serviceHelper.verifyAdminSession(headers);
      if (isAdmin) {
        const message = serviceHelper.createSuccessMessage('admin');
        res.json(message);
        return;
      }
      const isFluxTeam = await serviceHelper.verifyFluxTeamSession(headers);
      if (isFluxTeam) {
        const message = serviceHelper.createSuccessMessage('fluxteam');
        res.json(message);
        return;
      }
      const isUser = await serviceHelper.verifyUserSession(headers);
      if (isUser) {
        const message = serviceHelper.createSuccessMessage('user');
        res.json(message);
        return;
      }
      const message = serviceHelper.createErrorMessage('none');
      res.json(message);
    } catch (error) {
      log.error(error);
      const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
      res.json(errMessage);
    }
  });
}

module.exports = {
  loginPhrase,
  emergencyPhrase,
  verifyLogin,
  provideSign,
  activeLoginPhrases,
  loggedUsers,
  loggedSessions,
  logoutCurrentSession,
  logoutSpecificSession,
  logoutAllSessions,
  logoutAllUsers,
  wsRespondLoginPhrase,
  wsRespondSignature,
  checkLoggedUser,
};
