var mongoose = require('mongoose'),
    ObjectID = require('mongodb').ObjectID;

var postSchema = mongoose.Schema({
  owner: String,
  text: String
});

var Post = mongoose.model('Post', postSchema);

exports.add_post = function(postOwner, postText, callback) {
  // callback signature for add_post : function(err, newPost)
  console.log("[DB] Creating new post.");
  var newPost = new Post({
    owner: postOwner,
    text: postText
  });
  newPost.save(callback);
};

exports.remove_post = function(p_id, callback) {
  // callback signature for remove_post: function(err)
  Post.remove({ _id: new ObjectID(p_id) }, callback);
};

exports.get_all_posts = function(callback) {
  // callback signature for get_all_posts: function (err, posts)
  Post.find(callback);
};
