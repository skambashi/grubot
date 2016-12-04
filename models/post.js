var mongoose = require('mongoose'),
    autoIncrement = require('mongoose-auto-increment');

var postSchema = mongoose.Schema({
  id: Number,
  owner: String,
  text: String
});
postSchema.plugin(autoIncrement.plugin, { model: 'Post', field: 'id' });

var Post = mongoose.model('Post', postSchema);

exports.add_post = function(postOwner, postText, callback) {
  // callback signature for add_post : function(err, newPost)
  var newPost = new Post({
    owner: postOwner,
    text: postText
  });
  newPost.save(callback);
};

exports.remove_post = function(p_id, callback) {
  // callback signature for remove_post: function(err)
  Post.remove({ id: p_id }, callback);
};

exports.get_all_posts = function(callback) {
  // callback signature for get_all_posts: function (err, posts)
  Post.find(callback);
};
