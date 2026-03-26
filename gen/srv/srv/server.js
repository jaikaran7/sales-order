const cds = require('@sap/cds')

cds.on('bootstrap', app => {
  app.get('/', (req, res) => res.send('Sales Order App Running '))
})

module.exports = cds.server