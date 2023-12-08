/* Copyright (c) 2023 Richard Rodger and other contributors, MIT License. */
'use strict'

const { Open, Required, Default, Skip } = require('gubu')

module.exports = cosmos_store

module.exports.errors = {}

const intern = (module.exports.intern = make_intern())

module.exports.defaults = {
  test: false,

  // Provide COSMOS SDK (via function) externally so that it is not dragged into functions.
  sdk: Required(Function),

  // preserve undefined fields when saving
  merge: true,

  cosmos: Open({
    endpoint: Skip(String),
    key: Skip(String),
    connectionString: Skip(String),

    database: Open({
      create: Default(true, Boolean),
      config: Open({
        id: Required(String),
      }),
    }),

    container: Open({
      create: Default(true, Boolean),
      config: Open({
        partitionKey: {
          paths: Open(Default(['/id'], Array)),
          kind: Default('MultiHash', String),
          version: Default(2, Number),
        },
      }),
    }),
  }),

  client: Open({}),

  // entity meta data, by canon string
  entity: {},
}

function cosmos_store(options) {
  var seneca = this

  // TODO: need a better way to do this
  options = seneca.util.deep(
    {
      // TODO: use seneca.export once it allows for null values
      generate_id: seneca.export('entity/generate_id'),
    },
    options
  )

  const ctx = intern.make_ctx(
    {
      name: 'cosmos-store',
    },
    options
  )

  var store = intern.make_store(ctx)
  var meta = seneca.store.init(seneca, options, store)

  seneca.add({ init: store.name, tag: meta.tag }, function (msg, reply) {
    const COSMOS_SDK = options.sdk()

    if (options.cosmos.connectionString) {
      ctx.client = new COSMOS_SDK.CosmosClient(options.cosmos.connectionString)
    } else {
      ctx.client = new COSMOS_SDK.CosmosClient({
        endpoint: options.cosmos.endpoint,
        key: options.cosmos.key,
      })
    }

    const { config, create } = options.cosmos.database

    create_and_ref_database()

    async function create_and_ref_database() {
      intern.database = create
        ? (
            await ctx.client.databases.createIfNotExists({
              ...config,
            })
          ).database
        : ctx.client.database(config.id)

      reply()
    }
  })

  var plugin_meta = {
    name: store.name,
    tag: meta.tag,
    exports: {
      get_client: () => {
        return ctx.client
      },
    },
  }

  return plugin_meta
}

function make_intern() {
  return {
    PV: 1, // persistence version, used for data migration
    canon_ref: {},
    database: {},

    // TODO: why is this needed?
    clean_config: function (cfgin) {
      let cfg = { ...cfgin }
      for (let prop in cfg) {
        if (null == cfg[prop]) {
          delete cfg[prop]
        }
      }

      return cfg
    },

    make_msg: function (msg_fn, ctx) {
      return require('./lib/' + msg_fn)(ctx)
    },

    make_ctx: function (initial_ctx, options) {
      return Object.assign(
        {
          options,
          intern,
        },
        initial_ctx
      )
    },

    // TODO: seneca-entity should provide this
    entity_options: function (ent, ctx) {
      let canonkey = ent.canon$()

      // NOTE: canonkey in options can omit empty canon parts, and zone
      // so that canonkey can match seneca.entity abbreviated canon
      let entopts =
        intern.canon_ref[canonkey] ||
        ctx.options.entity[canonkey] ||
        ctx.options.entity[canonkey.replace(/^-\//, '')] ||
        ctx.options.entity[canonkey.replace(/^-\/-\//, '')] ||
        ctx.options.entity[canonkey.replace(/^[^/]+\/([^/]+\/[^/]+)$/, '$1')]

      intern.canon_ref[canonkey] = entopts

      return entopts
    },
    /*
    table: function (ent, ctx) {
   
      let table_name = null
      let entopts = intern.entity_options(ent, ctx)
      if (
        null != entopts &&
        null != entopts.table &&
        null != entopts.table.name
      ) {
        table_name = entopts.table.name
      } else {
        let canon = ent.canon$({ object: true })
        table_name = (canon.base ? canon.base + '_' : '') + canon.name
      }
      return table_name
      
    },
    */

    get_container: function (ent, ctx) {
      // let entopts = intern.entity_options(ent, ctx)
      // let table = entopts && entopts.table

      let container = {}

      let canon = ent.canon$({ object: true })

      container.name = (null != canon.base ? canon.base + '_' : '') + canon.name

      return container
    },

    load_container: async function (id, ctx, reply) {
      // console.log(ctx.options)
      const { config, create } = ctx.options.cosmos.container
      const containers = intern.database.containers

      try {
        const container = create
          ? (
              await containers.createIfNotExists({
                id,
                ...config,
              })
            ).container
          : intern.database.container(id)

        return container
      } catch (err) {
        reply(err, null)
      }
    },

    has_error: function (seneca, err, ctx, reply) {
      if (err) {
        seneca.log.error('entity', err, { store: ctx.name })
        reply(err)
      }
      return null != err
    },

    make_store: function (ctx) {
      const opts = ctx.options

      const store = {
        name: ctx.name,

        close: function (msg, reply) {
          reply()
        },

        save: function (msg, reply) {
          var seneca = this
          var ent = msg.ent

          var update = null != ent.id
          var co = intern.get_container(ent, ctx)
          var data = ent.data$(false)

          var item = data

          // console.log('save ent: ', ent, co)
          // console.log('data: ', data)
          var q = msg.q || {}

          // console.log(ent.id, opts.generate_id(ent))
          if (!update) {
            let new_id = ent.id$

            if (null == new_id) {
              new_id = opts.generate_id(ent)
            }

            data.id = new_id
          }

          do_upsert(ctx)

          async function do_upsert(ctx, args) {
            const container = await intern.load_container(co.name, ctx, reply)

            if (update) {
              intern.id_get(ctx, seneca, ent, co, q, async (err, res) => {
                if (res) {
                  item = res // { ...res }
                  Object.assign(item, data)
                }

                await upsert(item, reply)
              })
            } else {
              await upsert(item, reply)
            }

            async function upsert(item, reply) {
              try {
                item.entity$ = ent.entity$
                let rs = await container.items.upsert(item)
                // console.log('ent: ', rs.resource, item)
                // rs.resource
                return reply(
                  null,
                  ent.make$(intern.outbound(ctx, ent, rs.resource))
                )
              } catch (err) {
                return reply(err, null)
              }
            }
          }
        },

        load: function (msg, reply) {
          var seneca = this
          var qent = msg.qent
          var q = msg.q
          // const ti = intern.get_table(qent, ctx)
          // console.log('TI', ti)

          var qid = q.id

          var co = intern.get_container(qent, ctx)
          // console.log(q)

          if (null == qid) {
            if (0 === Object.keys(seneca.util.clean(q)).length) {
              return reply()
            }

            return intern.listent(
              ctx,
              seneca,
              qent,
              co,
              q,
              function (err, reslist) {
                if (err) return reply(err)

                return reply(0 != reslist.length ? reslist[0] : null)
              }
            )
          }

          // Load by id
          else {
            return intern.id_get(ctx, seneca, qent, co, q, reply)
          }
        },

        list: function (msg, reply) {
          var seneca = this
          var qent = msg.qent
          var q = msg.q

          var co = intern.get_container(qent, ctx)

          intern.listent(ctx, seneca, qent, co, q, reply)
        },

        remove: function (msg, reply) {
          var seneca = this
          // console.log('REMOVE MSG', msg)

          var qent = msg.qent
          var q = msg.q

          let co = intern.get_container(qent, ctx)

          var all = true === q.all$
          var load = true === q.load$

          let qid = q.id

          // console.log(q)
          do_remove()

          async function do_remove(args) {
            const container = await intern.load_container(co.name, ctx, reply)

            if (null != q.id) {
              await remove_single_by_id(q)
            } else {
              let cq = seneca.util.clean(q)

              if (0 === Object.keys(cq).length && !all) {
                reply(seneca.error('empty-remove-query'))
              }

              intern.listent(
                ctx,
                seneca,
                qent,
                co,
                cq,
                async function (listerr, list) {
                  if (intern.has_error(seneca, listerr, ctx, reply)) return

                  if (all) {
                    for (let item of list) {
                      await container.item(item.id, item.id).delete()
                    }
                    /*
                  // NOTE: using batch/bulk appears to be slower
                  let batchreq = 
                    list.map(item => ({
                      operationType: 'Delete',
                      id: item.id,
                      partitionKey: item.id
                    }))
                    
                  try {
                    await container.items.bulk(batchreq)
                  } catch(err) {
                    reply(err, null)
                  }
                  */

                    return reply()
                  } else {
                    qid = 0 < list.length ? list[0].id : null
                    return remove_single_by_id({ id: qid })
                  }
                }
              )
            }

            async function remove_single_by_id(q) {
              if (null != q.id) {
                if (load) {
                  return intern.id_get(
                    ctx,
                    seneca,
                    qent,
                    co,
                    q,
                    async (err, res) => {
                      await container.item(q.id, q.id).delete()
                      reply(res)
                    }
                  )
                } else {
                  try {
                    await container.item(q.id, q.id).delete()
                  } catch (err) {
                    if (err.body.code == 'NotFound') {
                      return reply()
                    }
                  }

                  return reply()
                }
              } else {
                return reply()
              }
            }

            // const { resources } = await container.items
          }
        },

        native: function (msg, reply) {
          reply({
            client: ctx.client,
          })
        },
      }

      return store
    },

    // Tmp converter for table parameter
    tableinfo: (table) => {
      let tableInfo = table
      if ('string' === typeof tableInfo) {
        tableInfo = { name: table }
      }
      return tableInfo
    },

    id_get: function (ctx, seneca, ent, co, q, reply) {
      do_load()

      async function do_load(args) {
        const container = await intern.load_container(co.name, ctx, reply)

        try {
          const { resource } = await container
            .item(q.id || ent.id, q.id || ent.id)
            .read()
          reply(
            null,
            resource ? ent.make$(intern.outbound(ctx, ent, resource)) : null
          )
        } catch (err) {
          // console.error(err.message)
          reply(err, null)
        }
      }
    },

    build_ops(qv, kname, type) {
      // TODO: enable these for cosmosDB

      if ('object' != typeof qv) {
        //  && !Array.isArray(qv)) {
        return { cmps: [{ c: '$ne', cmpop: '=', k: kname, v: qv }] }
      }

      let ops = {
        $gte: { cmpop: '>' },
        $gt: { cmpop: '>=' },
        $lt: { cmpop: '<=' },
        $lte: { cmpop: '<' },
        $ne: { cmpop: '=' },
      }

      // console.log('QV: ', typeof qv, qv)

      let cmps = []
      for (let k in qv) {
        let op = ops[k]
        if (op) {
          op.k = kname
          op.v = qv[k]
          op.c = k
          cmps.push(op)
        } else if (k.startsWith('$')) {
          throw new Error('Invalid Comparison Operator: ' + k)
        }
      }
      // special case
      if ('sort' == type && 1 < cmps.length) {
        throw new Error(
          'Only one condition per sortkey: ' + cmps.length + ' is given.'
        )
      }

      return { cmps }
    },

    listent: function (ctx, seneca, qent, co, q, reply) {
      let listreq = {}
      let listquery = 'SELECT'
      // let queryspec = {}

      var isarr = Array.isArray

      if (isarr(q) || 'object' != typeof q) {
        q = { id: q }
      }

      let cq = seneca.util.clean(q)
      let fq = cq

      let params = (listreq.parameters = [])

      if (null != q.limit$) {
        listquery += ' TOP ' + '@limit'
        params.push({
          name: '@limit',
          value: q.limit$,
        })
        // delete q.limit$
      }

      if (q.fields$) {
        listquery +=
          ' ' +
          q.fields$.map((k) => co.name + '.' + k).join(', ') +
          ' FROM ' +
          co.name
      } else {
        listquery += ' * FROM ' + co.name
      }

      if (0 < Object.keys(fq).length) {
        listquery += ' WHERE '

        listquery += Object.keys(cq)
          .map((k, i) => {
            let cq_k = isarr(cq[k]) ? cq[k] : [cq[k]]

            return (
              '(' +
              cq_k
                .map((v, j) => {
                  params.push({
                    name: '@i' + i + j,
                    value: v,
                  })
                  return co.name + '.' + k + ' = ' + '@' + ('i' + i + j)
                })
                .join(' OR ') +
              ')'
            )
          })
          .join(' AND ')
      }

      if (null != q.sort$) {
        let sort_order = {
          1: 'ASC',
          '-1': 'DESC',
        }

        if (typeof q.sort$ == 'object') {
          for (let k in q.sort$) {
            let order = sort_order[q.sort$[k]]
            if (null != order) {
              listquery += ' ORDER BY ' + co.name + '.' + k + ' ' + order
            }
          }
        }
      }

      listreq.query = listquery

      // console.log('list_req: ', listreq ) // , q, co)

      do_list()

      async function do_list(args) {
        const container = await intern.load_container(co.name, ctx, reply)
        let out_list = []
        const { resources } = await container.items.query(listreq).fetchAll()

        out_list = resources.map((resource) =>
          qent.make$(intern.outbound(ctx, qent, resource))
        )

        reply(null, out_list)
      }
    },

    inbound: function (ctx, ent, data) {
      if (null == data) return null

      let entity_options = intern.entity_options(ent, ctx)

      if (entity_options) {
        var fields = entity_options.fields || {}
        Object.keys(fields).forEach((fn) => {
          var fs = fields[fn] || {}
          var type = fs.type
          if ('date' === type && data[fn] instanceof Date) {
            data[fn] = data[fn].toISOString()
          }
        })
      }
      return data
    },

    outbound: function (ctx, ent, data) {
      if (null == data) return null

      let entity_options = intern.entity_options(ent, ctx)

      const defaultFields = ['_attachments', '_etag', '_rid', '_self', '_ts']

      for (let field of defaultFields) {
        if (null != data[field]) {
          delete data[field]
        }
      }

      if (entity_options) {
        var fields = entity_options.fields || {}
        Object.keys(fields).forEach((fn) => {
          var fs = fields[fn] || {}
          var type = fs.type
          if ('date' === type && 'string' === typeof data[fn]) {
            data[fn] = new Date(data[fn])
          }
        })
      }

      return data
    },
  }
}
